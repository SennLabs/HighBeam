// SPDX-License-Identifier: GPL-2.0-or-later
//
// Minimal test runner for HighBeam's shell-independent modules:
// `gjs -m tests/run.js`. Tests may be async; a GLib main loop runs while they
// are pending so timeouts fire.

import GLib from 'gi://GLib';
import System from 'system';

import {tests as calculatorTests} from './calculator.test.js';
import {tests as engineTests} from './engine.test.js';
import {tests as historyTests} from './history.test.js';
import {tests as historyFileTests} from './historyFile.test.js';
import {tests as rankingTests} from './ranking.test.js';

const suites = {ranking: rankingTests, engine: engineTests, calculator: calculatorTests, history: historyTests, historyFile: historyFileTests};

async function runAll() {
    let failed = 0;
    for (const [suite, tests] of Object.entries(suites)) {
        for (const [name, fn] of Object.entries(tests)) {
            try {
                await fn();
                print(`ok   ${suite}: ${name}`);
            } catch (e) {
                failed++;
                print(`FAIL ${suite}: ${name}\n     ${e.message}`);
            }
        }
    }
    return failed;
}

const loop = new GLib.MainLoop(null, false);
let failed = 1;
runAll().then(n => {
    failed = n;
}).catch(e => {
    print(`runner error: ${e}`);
}).finally(() => loop.quit());
loop.run();

print(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
System.exit(failed ? 1 : 0);
