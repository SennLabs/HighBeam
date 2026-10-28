// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {SearchEngine} from '../src/search/engine.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const sleep = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

// A provider that answers after `delay` ms with one result named after the query.
function fakeProvider(id, {isRemote = true, delay = 0} = {}) {
    return {
        id,
        name: id,
        isRemote,
        bias: 0,
        calls: 0,
        async search(terms) {
            this.calls++;
            if (delay)
                await sleep(delay);
            const name = terms.join(' ');
            return {state: null, results: [{id: `${id}:${name}`, name, score: 0.9}]};
        },
    };
}

function names(snapshot) {
    const all = snapshot.topHit ? [snapshot.topHit] : [];
    for (const section of snapshot.sections)
        all.push(...section.results);
    return all.map(r => r.id).sort().join(', ');
}

// A local provider returning fixed results, all with the same score.
function listProvider(id, ids, {score = 0.9, recordHistory} = {}) {
    return {
        id,
        name: id,
        isRemote: false,
        bias: 0,
        recordHistory,
        search() {
            return Promise.resolve({state: null, results: ids.map(r => ({id: r, name: r, score}))});
        },
    };
}

export const tests = {
    async 'boosted results move to the front and can become the Top Hit'() {
        let last = null;
        const engine = new SearchEngine(s => (last = s), {
            boosts: terms => new Map(terms[0] === 'fi' ? [['apps:firefox', 0.2]] : []),
        });
        engine.setProviders([listProvider('apps', ['firewall', 'fish', 'firefox'])]);

        engine.setQuery('fi');
        await engine.whenLocalReady();
        assert(last.topHit?.id === 'firefox', `top hit ${last.topHit?.id}`);
        assert(Math.abs(last.topHit.score - 1.1) < 1e-9, `score ${last.topHit.score}`);
        const rest = last.sections[0].results.map(r => r.id).join(',');
        assert(rest === 'firewall,fish', `others keep provider order, got ${rest}`);

        engine.setQuery('fis');
        await engine.whenLocalReady();
        assert(last.topHit?.id === 'firewall', `no boost for another query, got ${last.topHit?.id}`);
        engine.destroy();
    },

    async 'a weak boosted result does not block a strong Top Hit'() {
        let last = null;
        const engine = new SearchEngine(s => (last = s), {
            boosts: () => new Map([['apps:console', 0.1]]),
        });
        const apps = listProvider('apps', []);
        apps.search = () => Promise.resolve({state: null, results: [
            {id: 'texteditor', name: 'Text Editor', score: 0.9},
            {id: 'console', name: 'Console', score: 0.45},
        ]});
        engine.setProviders([apps]);
        engine.setQuery('te');
        await engine.whenLocalReady();
        assert(last.topHit?.id === 'texteditor', `top hit ${last.topHit?.id}`);
        engine.destroy();
    },

    async 'stale results expire even while the user keeps typing fast'() {
        let last = null;
        const engine = new SearchEngine(s => (last = s));
        // Answers only "f"; anything longer never comes back in time.
        const files = fakeProvider('files', {delay: 0});
        const realSearch = files.search.bind(files);
        files.search = terms => (terms[0] === 'f' ? realSearch(terms) : new Promise(() => {}));
        engine.setProviders([files]);
        engine.setQuery('f');
        await sleep(250);
        assert(names(last) === 'files:f', `first result, got ${names(last)}`);

        const word = 'finances';
        for (let i = 2; i <= word.length; i++) {
            engine.setQuery(word.slice(0, i));
            await sleep(100);
        }
        await sleep(600);
        assert(!last.sections.some(s => s.results.some(r => r.id === 'files:f')),
            `stale result still shown: ${names(last)}`);
        engine.destroy();
    },

    async 'snapshots mark stale sections'() {
        let last = null;
        const engine = new SearchEngine(s => (last = s));
        const files = fakeProvider('files', {delay: 400});
        engine.setProviders([files]);
        engine.setQuery('f');
        await sleep(700);
        engine.setQuery('fi');
        await sleep(50);
        assert(last.sections[0]?.stale === true, 'old section is stale');
        await sleep(700);
        // The fresh result is promoted to Top Hit; the stale one is gone.
        assert(last.topHit?.id === 'files:fi' && last.sections.length === 0,
            `fresh result shown, got ${JSON.stringify(last.sections)}`);
        engine.destroy();
    },

    async 'whenSettled waits for remote providers, with a timeout'() {
        const engine = new SearchEngine(() => {});
        engine.setProviders([fakeProvider('files', {delay: 100}), fakeProvider('slow', {delay: 5000})]);
        engine.setQuery('x');
        assert(engine.isSearching, 'searching');
        const start = Date.now();
        await engine.whenSettled(500);
        const waited = Date.now() - start;
        assert(waited >= 400 && waited < 1500, `timed out after ${waited} ms`);

        engine.setProviders([fakeProvider('files', {delay: 50})]);
        engine.setQuery('y');
        await engine.whenSettled(5000);
        assert(!engine.isSearching, 'settled');
        engine.destroy();
    },

    async 'bad provider answers and a failing UI callback are contained'() {
        let calls = 0;
        const engine = new SearchEngine(() => {
            calls++;
            throw new Error('ui broke');
        });
        const bad = listProvider('bad', []);
        bad.search = () => Promise.resolve({state: null, results: null});
        const worse = listProvider('worse', []);
        worse.search = () => Promise.resolve(undefined);
        engine.setProviders([bad, worse]);
        engine.setQuery('x');
        await engine.whenLocalReady();
        assert(calls > 0, 'UI was called');
        engine.destroy();
    },

    async 'providers that opt out of history are not boosted'() {
        let last = null;
        const engine = new SearchEngine(s => (last = s), {
            boosts: () => new Map([['windows:b', 0.2]]),
        });
        engine.setProviders([listProvider('windows', ['a', 'b'], {recordHistory: false})]);
        engine.setQuery('x');
        await engine.whenLocalReady();
        assert(last.topHit?.id === 'a', `got ${last.topHit?.id}`);
        engine.destroy();
    },

    async 'local results are ready before whenLocalReady resolves'() {
        let last = null;
        const engine = new SearchEngine(s => (last = s));
        engine.setProviders([fakeProvider('apps', {isRemote: false})]);
        engine.setQuery('fire');
        await engine.whenLocalReady();
        assert(last && names(last) === 'apps:fire', `got ${last && names(last)}`);
        engine.destroy();
    },

    async 'remote providers are debounced while typing'() {
        const remote = fakeProvider('files');
        const engine = new SearchEngine(() => {});
        engine.setProviders([remote]);
        for (const q of ['f', 'fi', 'fir', 'fire'])
            engine.setQuery(q);
        await sleep(300);
        assert(remote.calls === 1, `expected 1 call, got ${remote.calls}`);
        engine.destroy();
    },

    async 'slow provider: stale results expire, late results still appear'() {
        let last = null;
        const slow = fakeProvider('slow');
        const engine = new SearchEngine(s => (last = s));
        engine.setProviders([slow]);

        engine.setQuery('fi');
        await sleep(250);
        assert(names(last) === 'slow:fi', `first query: ${names(last)}`);

        // From now on the provider takes 1.5 s to answer. The next keystroke
        // is a subsearch, so the old result stays on screen...
        slow.search = async function (terms) {
            await sleep(1500);
            return {state: null, results: [{id: `slow:${terms.join(' ')}`, name: 'x', score: 0.9}]};
        };
        engine.setQuery('fire');
        await sleep(500);
        assert(names(last) === 'slow:fi', `old result should still show: ${names(last)}`);

        // ...until it has been stale for a second...
        await sleep(800);
        assert(names(last) === '', `stale result should be gone: ${names(last)}`);

        // ...and the slow answer is still shown when it arrives.
        await sleep(600);
        assert(names(last) === 'slow:fire', `late result should appear: ${names(last)}`);
        engine.destroy();
    },

    async 'results for an old query are ignored'() {
        let last = null;
        const slow = fakeProvider('slow', {isRemote: false, delay: 200});
        const engine = new SearchEngine(s => (last = s));
        engine.setProviders([slow]);
        engine.setQuery('old');
        engine.setQuery('new');
        await sleep(400);
        assert(names(last) === 'slow:new', `got ${names(last)}`);
        engine.destroy();
    },

    async 'reset leaves no pending callbacks'() {
        let updates = 0;
        const engine = new SearchEngine(() => updates++);
        engine.setProviders([fakeProvider('files', {delay: 100})]);
        engine.setQuery('fire');
        engine.reset();
        await sleep(1300);
        assert(updates === 0, `expected no updates after reset, got ${updates}`);
        engine.destroy();
    },
};
