// SPDX-License-Identifier: GPL-2.0-or-later
//
// Text matching and scoring. Pure JavaScript with no GNOME imports, so it can
// be unit-tested with plain `gjs -m`.

export const Score = Object.freeze({
    EXACT: 1.0,
    PREFIX: 0.9,
    WORD_PREFIX: 0.8,
    ALL_WORDS_PREFIX: 0.75,
    SUBSTRING: 0.6,
    FUZZY_MAX: 0.5,
    FUZZY_MIN: 0.2,
    NONE: 0,
});

/**
 * Lower-case and strip accents so "Café" matches "cafe".
 *
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
    return (text ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .trim();
}

/**
 * Split a query into search terms the way GNOME Shell does.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function splitTerms(query) {
    return query.trim().split(/\s+/).filter(t => t.length > 0);
}

function compact(normalized) {
    return normalized.replace(/[^\p{L}\p{N}]/gu, '');
}

function words(text) {
    // Split on whitespace and punctuation, and on camelCase boundaries
    // ("LibreOffice" → "libre", "office").
    return text
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[\s\-_./:()[\],]+/)
        .map(normalize)
        .filter(w => w.length > 0);
}

/**
 * Subsequence match: every query character appears in order in the text.
 * Returns a score in [FUZZY_MIN, FUZZY_MAX] that rewards tight matches and
 * matches on word starts, or NONE.
 *
 * @param {string} q normalized query
 * @param {string} t normalized text
 * @param {Set<number>} wordStarts indexes in t where a word begins
 * @returns {number}
 */
function fuzzy(q, t, wordStarts) {
    let ti = 0;
    let gaps = 0;
    let starts = 0;
    let last = -1;
    for (const ch of q) {
        if (ch === ' ')
            continue;
        const found = t.indexOf(ch, ti);
        if (found < 0)
            return Score.NONE;
        if (last >= 0 && found !== last + 1)
            gaps++;
        if (wordStarts.has(found))
            starts++;
        last = found;
        ti = found + 1;
    }
    const len = q.replace(/ /g, '').length;
    const tightness = 1 - gaps / Math.max(len, 1);
    const startRatio = starts / Math.max(len, 1);
    const quality = 0.6 * tightness + 0.4 * startRatio;
    return Score.FUZZY_MIN + (Score.FUZZY_MAX - Score.FUZZY_MIN) * quality;
}

/**
 * How well does `query` match `text`? Higher is better; 0 means no match.
 *
 * @param {string} query raw query typed by the user
 * @param {string} text candidate text (e.g. an app name)
 * @returns {number} score in [0, 1]
 */
export function score(query, text) {
    const q = normalize(query);
    const t = normalize(text);
    if (!q || !t)
        return Score.NONE;

    if (t === q)
        return Score.EXACT;
    if (t.startsWith(q))
        return Score.PREFIX;

    // Ignore punctuation and spaces so "wifi" matches "Wi-Fi" and
    // "libreoffice" matches "LibreOffice Writer".
    const qCompact = compact(q);
    const tCompact = compact(t);
    if (qCompact && tCompact === qCompact)
        return Score.EXACT;
    if (qCompact && tCompact.startsWith(qCompact))
        return Score.PREFIX;

    const tWords = words(text);
    if (tWords.some(w => w.startsWith(q)))
        return Score.WORD_PREFIX;

    const qWords = splitTerms(q);
    if (qWords.length > 1 &&
        qWords.every(qw => tWords.some(w => w.startsWith(qw))))
        return Score.ALL_WORDS_PREFIX;

    if (t.includes(q))
        return Score.SUBSTRING;

    const wordStarts = new Set();
    for (let i = 0; i < t.length; i++) {
        if (i === 0 || /[\s\-_./:()[\],]/.test(t[i - 1]))
            wordStarts.add(i);
    }
    return fuzzy(q, t, wordStarts);
}

/**
 * Pick the "Top Hit" from the first result of each section.
 *
 * Each candidate is `{result, bias}` where bias nudges some providers ahead of
 * others (apps beat files on a tie). Returns null unless the best candidate is
 * a reasonable textual match, so a weak fuzzy hit never takes the top spot.
 *
 * @param {{result: {score: number}, bias: number}[]} candidates
 * @param {number} [threshold]
 * @returns {object|null} the winning result
 */
export function pickTopHit(candidates, threshold = Score.SUBSTRING) {
    let best = null;
    let bestValue = -Infinity;
    for (const {result, bias} of candidates) {
        if (!result || result.score < threshold)
            continue;
        const value = result.score + bias;
        if (value > bestValue) {
            best = result;
            bestValue = value;
        }
    }
    return best;
}
