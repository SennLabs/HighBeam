// SPDX-License-Identifier: GPL-2.0-or-later

import {Score, normalize, pickTopHit, score, splitTerms} from '../src/search/ranking.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function assertEq(actual, expected, message = '') {
    assert(actual === expected, `${message} expected ${expected}, got ${actual}`);
}

export const tests = {
    'normalize strips case and accents'() {
        assertEq(normalize('  Café Crème '), 'cafe creme');
    },

    'splitTerms ignores extra whitespace'() {
        assertEq(JSON.stringify(splitTerms('  foo   bar ')), '["foo","bar"]');
        assertEq(splitTerms('   ').length, 0);
    },

    'exact beats prefix beats word prefix beats substring'() {
        assertEq(score('files', 'Files'), Score.EXACT);
        assertEq(score('fire', 'Firefox'), Score.PREFIX);
        assertEq(score('office', 'LibreOffice Writer'), Score.WORD_PREFIX);
        assertEq(score('wri', 'LibreOffice Writer'), Score.WORD_PREFIX);
        assertEq(score('ref', 'Firefox'), Score.SUBSTRING);
    },

    'camelCase words count as word starts'() {
        assertEq(score('off', 'LibreOffice'), Score.WORD_PREFIX);
    },

    'every query word can prefix a different word'() {
        assertEq(score('lib wri', 'LibreOffice Writer'), Score.ALL_WORDS_PREFIX);
    },

    'fuzzy matches score below substring and above zero'() {
        const s = score('lbo', 'LibreOffice');
        assert(s > Score.FUZZY_MIN && s < Score.SUBSTRING, `got ${s}`);
    },

    'tighter fuzzy matches score higher'() {
        assert(score('gnte', 'GNOME Text Editor') > score('gtxr', 'GNOME Text Editor'),
            'word-start fuzzy match should beat a scattered one');
    },

    'punctuation and spaces are ignored for whole-name matches'() {
        assertEq(score('wifi', 'Wi-Fi'), Score.EXACT);
        assertEq(score('libreoffice', 'LibreOffice Writer'), Score.PREFIX);
    },

    'no match is zero'() {
        assertEq(score('xyz', 'Firefox'), Score.NONE);
        assertEq(score('', 'Firefox'), Score.NONE);
    },

    'top hit picks the highest score plus bias'() {
        const app = {name: 'Files', score: Score.PREFIX};
        const file = {name: 'files.txt', score: Score.PREFIX};
        assertEq(pickTopHit([
            {result: file, bias: 0},
            {result: app, bias: 0.05},
        ]), app);
    },

    'top hit ignores weak matches'() {
        assertEq(pickTopHit([{result: {score: 0.3}, bias: 0.05}]), null);
        assertEq(pickTopHit([]), null);
    },
};
