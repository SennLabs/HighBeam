// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {History} from '../src/search/history.js';
import {HistoryFile} from '../src/util/historyFile.js';

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

// A path in a fresh temporary folder; the "highbeam" subfolder doesn't exist yet.
function tempPath() {
    const dir = GLib.dir_make_tmp('highbeam-test-XXXXXX');
    return GLib.build_filenamev([dir, 'highbeam', 'history.json']);
}

export const tests = {
    async 'saves after a delay and loads it back'() {
        const path = tempPath();
        const history = new History();
        const file = new HistoryFile(history, {path, saveDelayMs: 50});
        await file.loaded;
        assert(history.size === 0, 'starts empty without a file');

        history.record('fi', 'apps:firefox');
        file.scheduleSave();
        await sleep(300);
        assert(GLib.file_test(path, GLib.FileTest.EXISTS), 'file written');
        // Our own save must not look like a deletion.
        assert(history.size === 1, 'history kept after saving');
        file.destroy();

        const again = new History();
        const reload = new HistoryFile(again, {path, saveDelayMs: 50});
        await reload.loaded;
        assert(again.boosts('fi').has('apps:firefox'), 'loaded from disk');
        reload.destroy();
    },

    async 'forget clears memory and the file, even before the first save'() {
        const path = tempPath();
        const history = new History();
        const file = new HistoryFile(history, {path, saveDelayMs: 50});
        await file.loaded;
        history.record('fi', 'apps:firefox');
        file.scheduleSave();
        // Before the delayed save has run: nothing on disk yet.
        await file.forget();
        await sleep(300);
        assert(history.size === 0, `memory cleared, size ${history.size}`);
        assert(!GLib.file_test(path, GLib.FileTest.EXISTS), 'no file written afterwards');

        history.record('te', 'apps:terminal');
        file.scheduleSave();
        await sleep(300);
        assert(GLib.file_test(path, GLib.FileTest.EXISTS), 'saved again after new picks');
        await file.forget();
        assert(!GLib.file_test(path, GLib.FileTest.EXISTS), 'file deleted');
        file.destroy();
    },

    async 'a pick made before the file loads is kept'() {
        const path = tempPath();
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
        GLib.file_set_contents(path, JSON.stringify({version: 2, queries: [['fi', [['apps:firefox', 1, Date.now()]]]]}));
        const history = new History();
        const file = new HistoryFile(history, {path});
        history.record('te', 'apps:terminal');
        await file.loaded;
        assert(history.boosts('te').has('apps:terminal'), 'early pick kept');
        assert(history.boosts('fi').has('apps:firefox'), 'file loaded');
        file.destroy();
    },

    async 'destroy writes pending changes'() {
        const path = tempPath();
        const history = new History();
        const file = new HistoryFile(history, {path, saveDelayMs: 10000});
        await file.loaded;
        history.record('te', 'apps:terminal');
        file.scheduleSave();
        file.destroy();
        await sleep(300);
        assert(GLib.file_test(path, GLib.FileTest.EXISTS), 'written on destroy');
    },

    async 'unreadable files are ignored'() {
        const path = tempPath();
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
        GLib.file_set_contents(path, 'not json');
        const history = new History();
        const file = new HistoryFile(history, {path});
        await file.loaded;
        assert(history.size === 0, 'empty');
        file.destroy();
    },
};
