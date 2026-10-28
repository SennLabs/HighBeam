// SPDX-License-Identifier: GPL-2.0-or-later

import {evaluate, formatNumber} from '../src/search/calculator.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function assertEq(actual, expected, message = '') {
    assert(actual === expected, `${message} expected ${expected}, got ${actual}`);
}

function assertClose(actual, expected, message = '') {
    assert(actual !== null && Math.abs(actual - expected) < 1e-9,
        `${message} expected ≈${expected}, got ${actual}`);
}

export const tests = {
    'basic arithmetic and precedence'() {
        assertEq(evaluate('2+2'), 4);
        assertEq(evaluate('2 + 3 * 4'), 14);
        assertEq(evaluate('(2 + 3) * 4'), 20);
        assertEq(evaluate('10 / 4'), 2.5);
        assertEq(evaluate('10 % 4'), 2);
        assertEq(evaluate('8 - 2 - 1'), 5);
    },

    'powers are right-associative and bind tighter than unary minus'() {
        assertEq(evaluate('2^3^2'), 512);
        assertEq(evaluate('-2^2'), -4);
        assertEq(evaluate('2**10'), 1024);
        assertEq(evaluate('2^-1'), 0.5);
    },

    'unary minus, factorial and decimals'() {
        assertEq(evaluate('-3 * -2'), 6);
        assertEq(evaluate('5!'), 120);
        assertEq(evaluate('.5 + 1.25'), 1.75);
        assertEq(evaluate('1e3 + 1'), 1001);
    },

    'functions and constants'() {
        assertEq(evaluate('sqrt(16)'), 4);
        assertEq(evaluate('sqrt 16 + 1'), 5);
        assertEq(evaluate('√9'), 3);
        assertClose(evaluate('sin(pi/2)'), 1);
        assertClose(evaluate('2pi'), 2 * Math.PI);
        assertEq(evaluate('log(1000)'), 3);
        assertEq(evaluate('log2(8)'), 3);
        assertEq(evaluate('abs(-7)'), 7);
    },

    'typographic and implicit multiplication'() {
        assertEq(evaluate('3 × 4'), 12);
        assertEq(evaluate('12 ÷ 4'), 3);
        assertEq(evaluate('2 x 3'), 6);
        assertEq(evaluate('2x3'), 6);
        assertEq(evaluate('3(4+1)'), 15);
        assertEq(evaluate('5 − 2'), 3);
    },

    'non-calculations give null'() {
        for (const text of ['', '42', '-5', '(5)', 'pi', 'e', 'firefox', 'x',
            'log', '2+', '(2+3', '1/0', '0/0', '171!', '2.5!', 'sqrt(-1)', 'files 2'])
            assertEq(evaluate(text), null, `"${text}":`);
    },

    'numbers side by side are not multiplied'() {
        for (const text of ['1.2.3', '192.168.1.1', '10.0.0.1', '0412 345 678', '+61 412 345 678',
            '(08) 9123 4567', '1 000 000', '3 4', '1e', '2e', '0x10'])
            assertEq(evaluate(text), null, `"${text}":`);
        assertEq(evaluate('2e3 + 1'), 2001);
        assertClose(evaluate('3 e'), 3 * Math.E);
    },

    'power and factorial after a bracketed function apply to its result'() {
        assertClose(evaluate('sin(pi/2)^2'), 1);
        assertClose(evaluate('ln(e)^2'), 1);
        assertClose(evaluate('exp(1)^2'), Math.E ** 2);
        assertEq(evaluate('floor(2.5)^2'), 4);
        assertEq(evaluate('sqrt(4)!'), 2);
        assertEq(evaluate('abs(-3)!'), 6);
        assertEq(evaluate('sqrt 16 + 1'), 5);
    },

    'deep nesting and long input give null instead of throwing'() {
        assertEq(evaluate(`${'('.repeat(5000)}1${')'.repeat(5000)}`), null);
        assertEq(evaluate(`${'-'.repeat(100000)}1+1`), null);
        assertEq(evaluate(`${'sqrt '.repeat(3000)}2`), null);
        assertEq(evaluate(`${'(('.repeat(20)}1+1${'))'.repeat(20)}`), 2);
    },

    'large integers are exact or clearly rounded'() {
        assertEq(formatNumber(evaluate('1000000000000001+1')), '1000000000000002');
        assertEq(formatNumber(evaluate('2^53-1')), '9007199254740991');
        assertEq(formatNumber(evaluate('2^60')), '1.15292150461e+18');
        assertEq(formatNumber(1e21), '1e+21');
    },

    'formatNumber hides floating-point noise'() {
        assertEq(formatNumber(0.1 + 0.2), '0.3');
        assertEq(formatNumber(42), '42');
        assertEq(formatNumber(-0), '0');
        assertEq(formatNumber(1 / 3), '0.333333333333');
        assertEq(formatNumber(2 ** 70), '1.18059162072e+21');
        assertEq(formatNumber(-(2 ** 70)), '-1.18059162072e+21');
    },
};
