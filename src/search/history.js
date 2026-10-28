// SPDX-License-Identifier: GPL-2.0-or-later
//
// Remembers which result the user picked for each query, so the same pick
// ranks higher next time ("fi" → Firefox, like Spotlight). Pure JavaScript
// with no GNOME imports, so it can be unit-tested with `gjs -m`; reading and
// writing the file is in src/util/historyFile.js.
//
// A pick also counts for related queries: picking Firefox after typing "fire"
// boosts it for "fi" and "firefox" too, at a lower weight.

import {normalize} from './ranking.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// A pick's weight halves every this many days.
const HALF_LIFE_DAYS = 14;
// Picks older than this are forgotten.
const MAX_AGE_DAYS = 90;
const MAX_QUERIES = 300;
const MAX_KEYS_PER_QUERY = 8;
// Weight of a pick made with a longer or shorter form of the query.
const RELATED_WEIGHT = 0.5;
// A pick made after typing fewer characters than this only counts for that
// exact query, so picking Terminal for "t" doesn't boost it for every query
// starting with t.
const MIN_RELATED_LENGTH = 2;
// The largest boost added to a result's score. Score.PREFIX + MAX_BOOST beats
// Score.EXACT, so a well-used prefix pick wins over an exact name match, but
// a fuzzy match never climbs above a good textual one.
export const MAX_BOOST = 0.25;

// Version 2 stores queries as [query, [[key, count, last], …]] pairs, in
// least-recently-used order. Version 1 used objects, which reorder numeric
// keys and can't hold a query named "__proto__"; it is still read.
const VERSION = 2;

/**
 * @param {string} providerId
 * @param {string} resultId
 * @returns {string} the key a pick is stored under
 */
export function resultKey(providerId, resultId) {
    return `${providerId}:${resultId}`;
}

export class History {
    constructor() {
        // normalized query → Map(result key → {count, last})
        this._queries = new Map();
    }

    get size() {
        return this._queries.size;
    }

    clear() {
        this._queries.clear();
    }

    /**
     * Load data from toJSON(). Picks already in memory (made before the file
     * finished loading) are kept and count as the most recent. Invalid data
     * is ignored.
     *
     * @param {object} data
     * @param {number} [now] ms since the epoch
     */
    load(data, now = Date.now()) {
        const current = this._queries;
        this._queries = new Map();
        for (const [query, key, count, last] of parse(data)) {
            const q = normalize(query);
            if (!q || typeof key !== 'string' || !(count > 0) || !Number.isFinite(last))
                continue;
            // A clock that was wrong when the pick was saved mustn't make it
            // last forever.
            this._add(q, key, Math.min(count, 1e6), Math.min(last, now));
        }
        for (const [q, entries] of current) {
            for (const [key, {count, last}] of entries)
                this._add(q, key, count, last);
        }
        this._prune(now);
    }

    toJSON() {
        const queries = [];
        for (const [query, entries] of this._queries)
            queries.push([query, [...entries].map(([key, {count, last}]) => [key, count, last])]);
        return {version: VERSION, queries};
    }

    // Add to a query's entry, moving it to the most recently used end.
    _add(q, key, count, last) {
        const entries = this._queries.get(q) ?? new Map();
        this._queries.delete(q);
        this._queries.set(q, entries);
        const entry = entries.get(key);
        entries.delete(key);
        entries.set(key, {count: (entry?.count ?? 0) + count, last: Math.max(entry?.last ?? 0, last)});
    }

    /**
     * Note that `key` was picked for `query`.
     *
     * @param {string} query the query as typed
     * @param {string} key from resultKey()
     * @param {number} [now] ms since the epoch
     */
    record(query, key, now = Date.now()) {
        const q = normalize(query);
        if (!q)
            return;
        this._add(q, key, 1, now);
        this._prune(now);
    }

    /**
     * How much to add to each previously picked result's score for `query`.
     *
     * @param {string} query the query as typed
     * @param {number} [now] ms since the epoch
     * @returns {Map<string, number>} result key → boost in (0, MAX_BOOST]
     */
    boosts(query, now = Date.now()) {
        const q = normalize(query);
        const strength = new Map();
        if (!q)
            return strength;

        for (const [past, entries] of this._queries) {
            let weight;
            if (past === q)
                weight = 1;
            else if (past.length >= MIN_RELATED_LENGTH && (past.startsWith(q) || q.startsWith(past)))
                weight = RELATED_WEIGHT;
            else
                continue;

            for (const [key, {count, last}] of entries) {
                const ageDays = Math.max(0, now - last) / DAY_MS;
                const value = weight * count * 0.5 ** (ageDays / HALF_LIFE_DAYS);
                strength.set(key, (strength.get(key) ?? 0) + value);
            }
        }

        // Diminishing returns: one exact pick ≈ 0.1, three ≈ 0.19, never
        // more than MAX_BOOST.
        const boosts = new Map();
        for (const [key, value] of strength) {
            const boost = MAX_BOOST * (1 - Math.exp(-value / 2));
            if (boost > 0.001)
                boosts.set(key, boost);
        }
        return boosts;
    }

    _prune(now) {
        const cutoff = now - MAX_AGE_DAYS * DAY_MS;
        for (const [query, entries] of this._queries) {
            for (const [key, {last}] of entries) {
                if (last < cutoff)
                    entries.delete(key);
            }
            // Oldest first, so drop from the front.
            while (entries.size > MAX_KEYS_PER_QUERY)
                entries.delete(entries.keys().next().value);
            if (entries.size === 0)
                this._queries.delete(query);
        }
        while (this._queries.size > MAX_QUERIES)
            this._queries.delete(this._queries.keys().next().value);
    }
}

/**
 * Flatten saved data of either version into [query, key, count, last] rows,
 * oldest first. Anything malformed is skipped.
 *
 * @param {object} data
 * @returns {Array[]}
 */
function parse(data) {
    const rows = [];
    if (data?.version === 2 && Array.isArray(data.queries)) {
        for (const item of data.queries) {
            if (!Array.isArray(item) || typeof item[0] !== 'string' || !Array.isArray(item[1]))
                continue;
            for (const entry of item[1]) {
                if (Array.isArray(entry))
                    rows.push([item[0], entry[0], entry[1], entry[2]]);
            }
        }
    } else if (data?.version === 1 && typeof data.queries === 'object' && data.queries) {
        for (const [query, keys] of Object.entries(data.queries)) {
            if (typeof keys !== 'object' || !keys)
                continue;
            for (const [key, value] of Object.entries(keys)) {
                if (Array.isArray(value))
                    rows.push([query, key, value[0], value[1]]);
            }
        }
    }
    return rows;
}
