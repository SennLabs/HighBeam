// SPDX-License-Identifier: GPL-2.0-or-later

import {History, MAX_BOOST, resultKey} from '../src/search/history.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 12);
const FIREFOX = resultKey('highbeam-apps', 'firefox.desktop');
const FIREWALL = resultKey('highbeam-apps', 'firewall-config.desktop');

export const tests = {
    'a pick boosts the same result for the same query'() {
        const h = new History();
        h.record('fi', FIREFOX, NOW);
        const boosts = h.boosts('fi', NOW);
        assert(boosts.get(FIREFOX) > 0, 'Firefox boosted');
        assert(!boosts.has(FIREWALL), 'Firewall not boosted');
    },

    'queries are normalized'() {
        const h = new History();
        h.record('  Fí ', FIREFOX, NOW);
        assert(h.boosts('fi', NOW).get(FIREFOX) > 0, 'matched');
    },

    'related queries count, but less than the exact query'() {
        const h = new History();
        h.record('fire', FIREFOX, NOW);
        const exact = h.boosts('fire', NOW).get(FIREFOX);
        const shorter = h.boosts('fi', NOW).get(FIREFOX);
        const longer = h.boosts('firefox', NOW).get(FIREFOX);
        assert(shorter > 0 && shorter < exact, `shorter ${shorter} < exact ${exact}`);
        assert(longer > 0 && longer < exact, `longer ${longer} < exact ${exact}`);
        assert(!h.boosts('chrome', NOW).has(FIREFOX), 'unrelated query');
        assert(!h.boosts('', NOW).has(FIREFOX), 'empty query');
    },

    'more picks boost more, up to the cap'() {
        const h = new History();
        let previous = 0;
        for (let i = 0; i < 50; i++) {
            h.record('fi', FIREFOX, NOW);
            const boost = h.boosts('fi', NOW).get(FIREFOX);
            assert(boost >= previous && boost <= MAX_BOOST, `pick ${i}: ${boost}`);
            previous = boost;
        }
        assert(previous > MAX_BOOST * 0.95, 'approaches the cap');
    },

    'old picks fade and are eventually forgotten'() {
        const h = new History();
        h.record('fi', FIREFOX, NOW);
        const fresh = h.boosts('fi', NOW).get(FIREFOX);
        const later = h.boosts('fi', NOW + 14 * DAY).get(FIREFOX);
        assert(later < fresh, 'fades');

        h.record('fo', FIREWALL, NOW + 100 * DAY);
        assert(!h.boosts('fi', NOW + 100 * DAY).has(FIREFOX), 'pruned after 90 days');
        assert(h.size === 1, `one query left, got ${h.size}`);
    },

    'size is capped, dropping the least recently used'() {
        const h = new History();
        for (let i = 0; i < 400; i++)
            h.record(`q${i}`, FIREFOX, NOW + i);
        assert(h.size === 300, `size ${h.size}`);
        assert(!h.boosts('q0', NOW + 400).has(FIREFOX), 'oldest query dropped');
        assert(h.boosts('q399', NOW + 400).has(FIREFOX), 'newest query kept');

        const keys = new History();
        for (let i = 0; i < 20; i++)
            keys.record('a', resultKey('p', String(i)), NOW + i);
        const boosts = keys.boosts('a', NOW + 20);
        assert(boosts.size === 8, `keys per query ${boosts.size}`);
        assert(boosts.has(resultKey('p', '19')) && !boosts.has(resultKey('p', '0')), 'kept newest');
    },

    'one-letter picks only count for that letter'() {
        const h = new History();
        h.record('t', FIREFOX, NOW);
        assert(h.boosts('t', NOW).has(FIREFOX), 'exact');
        assert(!h.boosts('tea', NOW).has(FIREFOX), 'not for longer queries');
        h.record('fi', FIREWALL, NOW);
        assert(h.boosts('fire', NOW).has(FIREWALL), 'two letters do count');
    },

    'odd queries survive a round trip in order'() {
        const h = new History();
        h.record('__proto__', FIREFOX, NOW);
        h.record('q', FIREFOX, NOW + 1);
        h.record('7', FIREWALL, NOW + 2);
        const copy = new History();
        copy.load(JSON.parse(JSON.stringify(h)), NOW + 3);
        assert(copy.size === 3, `size ${copy.size}`);
        assert(copy.boosts('__proto__', NOW + 3).has(FIREFOX), '__proto__ kept');
        // "7" was used last, so it must still be the newest after reloading.
        assert(JSON.stringify(copy.toJSON().queries.map(q => q[0])) === '["__proto__","q","7"]',
            JSON.stringify(copy.toJSON().queries));
    },

    'loading normalizes queries, drops empty ones and clamps future dates'() {
        const h = new History();
        h.load({version: 2, queries: [
            [' FIRE ', [[FIREFOX, 1, NOW]]],
            ['', [[FIREWALL, 50, NOW]]],
            ['wall', [[FIREWALL, 1, NOW + 3650 * DAY]]],
        ]}, NOW);
        assert(h.boosts('fire', NOW).has(FIREFOX), 'normalized');
        assert(!h.boosts('anything', NOW).has(FIREWALL), 'empty query dropped');
        assert(!h.boosts('wall', NOW + 100 * DAY).has(FIREWALL), 'future pick still expires');
    },

    'loading keeps picks made before the file loaded'() {
        const h = new History();
        h.record('te', FIREWALL, NOW + 10);
        h.load({version: 2, queries: [['fi', [[FIREFOX, 1, NOW]]]]}, NOW + 20);
        assert(h.boosts('te', NOW + 20).has(FIREWALL), 'kept the early pick');
        assert(h.boosts('fi', NOW + 20).has(FIREFOX), 'loaded the file');
    },

    'version 1 files are still read'() {
        const h = new History();
        h.load({version: 1, queries: {fi: {[FIREFOX]: [2, NOW]}}}, NOW);
        assert(h.boosts('fi', NOW).has(FIREFOX), 'v1 loaded');
    },

    'survives a JSON round trip; bad data is ignored'() {
        const h = new History();
        h.record('fi', FIREFOX, NOW);
        h.record('fi', FIREFOX, NOW);
        h.record('wall', FIREWALL, NOW);

        const copy = new History();
        copy.load(JSON.parse(JSON.stringify(h)), NOW);
        assert(copy.size === 2, 'two queries');
        assert(copy.boosts('fi', NOW).get(FIREFOX) === h.boosts('fi', NOW).get(FIREFOX), 'same boost');

        for (const bad of [null, {}, {version: 99, queries: {}}, {version: 1, queries: {a: {k: 'x'}}},
            {version: 1, queries: {a: {k: [-1, NOW]}}}, {version: 2, queries: [['a', [[1, 1, NOW]]]]},
            {version: 2, queries: [['a', [['k', NaN, NOW]]]]}, {version: 2, queries: 'x'}]) {
            const b = new History();
            b.load(bad, NOW);
            assert(b.size === 0, `bad data ${JSON.stringify(bad)}`);
        }
    },
};
