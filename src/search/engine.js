// SPDX-License-Identifier: GPL-2.0-or-later
//
// Runs a query against every provider and streams merged results to the UI.
//
// Local providers (apps) run as soon as the query changes, so the first result
// is ready almost instantly. Remote D-Bus providers are debounced, run in
// parallel, and each one's results are shown as soon as they arrive, so a slow
// provider never holds up the rest.
//
// A provider looks like:
//   {
//     id, name, isRemote, bias, canLaunchSearch,
//     recordHistory,                  // false: never boosted or learned from
//     async search(terms, previousState, cancellable) -> {state, results},
//     activate(result, terms, {secondary}),
//     launchSearch(terms),            // only when canLaunchSearch
//   }
// and each result like:
//   {id, name, description, createIcon(size), score}
//
// An optional `boosts(terms)` function returns extra score for results the
// user picked before (see history.js). Boosted results move to the top of
// their section and are favoured for the Top Hit.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {resultKey} from './history.js';
import {pickTopHit, splitTerms} from './ranking.js';

const REMOTE_DEBOUNCE_MS = 150;
// While the user types, each provider's results for the previous query stay
// on screen until its new ones arrive. If that takes longer than this, the old
// results are removed so they don't linger.
const STALE_TIMEOUT_MS = 1000;

function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * @typedef {object} Snapshot
 * @property {string[]} terms
 * @property {object|null} topHit result promoted to the top of the list
 * @property {{provider: object, results: object[]}[]} sections
 */

export class SearchEngine {
    /**
     * @param {(snapshot: Snapshot) => void} onUpdate called whenever the
     *   visible results change
     * @param {object} [options]
     * @param {(terms: string[]) => Map<string, number>} [options.boosts]
     *   extra score per result key (from resultKey())
     */
    constructor(onUpdate, {boosts = null} = {}) {
        this._onUpdate = onUpdate;
        this._boosts = boosts;
        // Boosts for the current generation, computed once per query.
        this._boostCache = {generation: -1, boosts: null};
        this._providers = [];
        this._query = '';
        this._terms = [];
        this._generation = 0;
        this._cancellable = new Gio.Cancellable();
        this._debounceId = 0;
        this._staleSweepId = 0;
        // Providers that haven't answered the current query yet, and callers
        // of whenSettled() waiting for them.
        this._pending = new Set();
        this._settledWaiters = [];
        // providerId → {state, results, fresh}
        this._entries = new Map();
        this._localDone = Promise.resolve();
    }

    /**
     * Replace the provider list (e.g. after the user changes GNOME's search
     * settings) and re-run the current query.
     *
     * @param {object[]} providers in display order
     */
    setProviders(providers) {
        this._providers = providers;
        const query = this._query;
        this.reset();
        if (query)
            this.setQuery(query);
    }

    /**
     * @param {string} text the raw text in the search entry
     */
    setQuery(text) {
        const terms = splitTerms(text);
        const query = terms.join(' ');
        if (query === this._query)
            return;

        const previousQuery = this._query;
        this._query = query;
        this._terms = terms;

        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        this._clearDebounce();
        const generation = ++this._generation;
        this._pending = new Set(terms.length > 0 ? this._providers.map(p => p.id) : []);

        if (terms.length === 0) {
            this._entries.clear();
            this._clearStaleSweep();
            this._localDone = Promise.resolve();
            this._emit();
            this._checkSettled();
            return;
        }

        // When the user keeps typing ("fir" → "fire"), providers can narrow
        // their previous results instead of starting over, and the old results
        // stay on screen until the new ones arrive, to reduce flicker. They
        // expire STALE_TIMEOUT_MS after they first went stale, however fast
        // the user keeps typing.
        const isSubsearch = previousQuery.length > 0 && query.startsWith(previousQuery);
        if (isSubsearch) {
            const now = GLib.get_monotonic_time() / 1000;
            for (const entry of this._entries.values()) {
                if (entry.fresh) {
                    entry.fresh = false;
                    entry.staleSince = now;
                }
            }
            this._scheduleStaleSweep();
            this._emit();
        } else {
            this._entries.clear();
            this._clearStaleSweep();
        }

        const cancellable = this._cancellable;
        const run = provider => {
            const previous = isSubsearch ? this._entries.get(provider.id) : null;
            return this._runProvider(provider, generation, terms, previous?.state ?? null, cancellable);
        };

        const local = this._providers.filter(p => !p.isRemote);
        const remote = this._providers.filter(p => p.isRemote);

        this._localDone = Promise.all(local.map(run));

        if (remote.length > 0) {
            this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REMOTE_DEBOUNCE_MS, () => {
                this._debounceId = 0;
                remote.forEach(run);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /**
     * Resolves once the local providers have answered the current query, so
     * pressing Enter right after typing activates an up-to-date result.
     *
     * @returns {Promise<void>}
     */
    whenLocalReady() {
        return this._localDone.then(() => {});
    }

    /**
     * Resolves once every provider has answered the current query, the query
     * changes, or `timeoutMs` passes, whichever comes first.
     *
     * @param {number} timeoutMs
     * @returns {Promise<void>}
     */
    whenSettled(timeoutMs) {
        if (this._pending.size === 0)
            return Promise.resolve();
        return new Promise(resolve => {
            const waiter = {resolve, timeoutId: 0};
            waiter.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                waiter.timeoutId = 0;
                this._settleWaiter(waiter);
                return GLib.SOURCE_REMOVE;
            });
            this._settledWaiters.push(waiter);
        });
    }

    /** Whether some provider hasn't answered the current query yet. */
    get isSearching() {
        return this._pending.size > 0;
    }

    get terms() {
        return this._terms;
    }

    reset() {
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        this._clearDebounce();
        this._clearStaleSweep();
        this._generation++;
        this._query = '';
        this._terms = [];
        this._entries.clear();
        this._localDone = Promise.resolve();
        this._pending.clear();
        this._checkSettled();
    }

    destroy() {
        this.reset();
        this._onUpdate = null;
        this._providers = [];
    }

    _clearDebounce() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
    }

    _clearStaleSweep() {
        if (this._staleSweepId) {
            GLib.source_remove(this._staleSweepId);
            this._staleSweepId = 0;
        }
    }

    // Remove stale entries when they expire. One timer, set for the oldest.
    _scheduleStaleSweep() {
        if (this._staleSweepId)
            return;
        let oldest = Infinity;
        for (const entry of this._entries.values()) {
            if (!entry.fresh)
                oldest = Math.min(oldest, entry.staleSince);
        }
        if (oldest === Infinity)
            return;
        const delay = Math.max(0, Math.ceil(oldest + STALE_TIMEOUT_MS - GLib.get_monotonic_time() / 1000));
        this._staleSweepId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._staleSweepId = 0;
            const now = GLib.get_monotonic_time() / 1000;
            let removed = false;
            for (const [id, entry] of this._entries) {
                if (!entry.fresh && now - entry.staleSince >= STALE_TIMEOUT_MS - 1) {
                    this._entries.delete(id);
                    removed = true;
                }
            }
            if (removed)
                this._emit();
            this._scheduleStaleSweep();
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkSettled() {
        if (this._pending.size > 0)
            return;
        for (const waiter of [...this._settledWaiters])
            this._settleWaiter(waiter);
    }

    _settleWaiter(waiter) {
        const index = this._settledWaiters.indexOf(waiter);
        if (index < 0)
            return;
        this._settledWaiters.splice(index, 1);
        if (waiter.timeoutId)
            GLib.source_remove(waiter.timeoutId);
        waiter.resolve();
    }

    async _runProvider(provider, generation, terms, previousState, cancellable) {
        let entry;
        try {
            const answer = await provider.search(terms, previousState, cancellable);
            const results = Array.isArray(answer?.results) ? answer.results : [];
            entry = {state: answer?.state ?? null, results: this._applyBoosts(provider, results, generation), fresh: true};
        } catch (error) {
            if (isCancelled(error))
                return;
            console.error(`HighBeam: search provider ${provider.id} failed: ${error}`);
            entry = {state: null, results: [], fresh: true};
        }

        if (generation !== this._generation)
            return;

        this._entries.set(provider.id, entry);
        this._pending.delete(provider.id);
        this._emit();
        this._checkSettled();
    }

    _currentBoosts(generation) {
        if (this._boostCache.generation !== generation) {
            let boosts = null;
            try {
                boosts = this._boosts?.(this._terms) ?? null;
            } catch (e) {
                console.error(`HighBeam: ranking history failed: ${e}`);
            }
            this._boostCache = {generation, boosts};
        }
        return this._boostCache.boosts;
    }

    // Raise the score of results picked before, and move them to the front of
    // their section (most boosted first). The rest keep the provider's order.
    _applyBoosts(provider, results, generation) {
        if (generation !== this._generation || provider.recordHistory === false)
            return results;
        const boosts = this._currentBoosts(generation);
        if (!boosts || boosts.size === 0)
            return results;

        const boosted = [];
        const rest = [];
        for (const result of results) {
            const boost = boosts.get(resultKey(provider.id, result.id));
            if (boost)
                boosted.push({...result, score: result.score + boost});
            else
                rest.push(result);
        }
        if (boosted.length === 0)
            return results;
        // Each boosted result goes in front of the first result it now
        // outscores, so a weak match picked once doesn't jump a strong one.
        boosted.sort((a, b) => b.score - a.score);
        const merged = [];
        for (const result of rest) {
            while (boosted.length > 0 && boosted[0].score >= result.score)
                merged.push(boosted.shift());
            merged.push(result);
        }
        return [...merged, ...boosted];
    }

    _emit() {
        if (!this._onUpdate)
            return;

        const sections = [];
        for (const provider of this._providers) {
            const entry = this._entries.get(provider.id);
            if (entry && entry.results.length > 0)
                sections.push({provider, results: [...entry.results], fresh: entry.fresh});
        }

        // Only fresh results may become the Top Hit; stale ones belong to the
        // previous, shorter query.
        const topHit = pickTopHit(sections
            .filter(s => s.fresh)
            .map(s => ({
                result: s.results.reduce((best, r) => (r.score > best.score ? r : best)),
                bias: s.provider.bias,
            })));

        if (topHit) {
            for (const section of sections) {
                const index = section.results.indexOf(topHit);
                if (index >= 0) {
                    topHit.provider = section.provider;
                    section.results.splice(index, 1);
                }
            }
        }

        try {
            this._onUpdate({
                terms: this._terms,
                topHit,
                sections: sections
                    .filter(s => s.results.length > 0)
                    .map(({provider, results, fresh}) => ({provider, results, stale: !fresh})),
            });
        } catch (e) {
            console.error(`HighBeam: failed to show results: ${e}`);
        }
    }
}
