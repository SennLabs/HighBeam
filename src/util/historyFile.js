// SPDX-License-Identifier: GPL-2.0-or-later
//
// Loads and saves the selection history (src/search/history.js) as JSON in
// $XDG_DATA_HOME/highbeam/history.json. All file access is asynchronous, and
// saves are batched.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SAVE_DELAY_MS = 2000;

function isError(e, code) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, code);
}

// Callback-style async calls wrapped in promises. (Gio._promisify would patch
// Gio.File.prototype for every extension as soon as this module loads.)
function loadContents(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (_f, res) => {
            try {
                resolve(file.load_contents_finish(res)[1]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function makeDirectory(file) {
    return new Promise((resolve, reject) => {
        file.make_directory_async(GLib.PRIORITY_DEFAULT, null, (_f, res) => {
            try {
                resolve(file.make_directory_finish(res));
            } catch (e) {
                if (isError(e, Gio.IOErrorEnum.EXISTS))
                    resolve(false);
                else
                    reject(e);
            }
        });
    });
}

function replaceContents(file, bytes) {
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null,
            (_f, res) => {
                try {
                    resolve(file.replace_contents_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function deleteFile(file) {
    return new Promise((resolve, reject) => {
        file.delete_async(GLib.PRIORITY_DEFAULT, null, (_f, res) => {
            try {
                resolve(file.delete_finish(res));
            } catch (e) {
                if (isError(e, Gio.IOErrorEnum.NOT_FOUND))
                    resolve(false);
                else
                    reject(e);
            }
        });
    });
}

/**
 * @returns {string} where the history is stored
 */
export function historyPath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'highbeam', 'history.json']);
}

export class HistoryFile {
    /**
     * @param {import('../search/history.js').History} history filled once
     *   the file has loaded
     * @param {object} [options] for tests
     * @param {string} [options.path]
     * @param {number} [options.saveDelayMs]
     */
    constructor(history, {path = historyPath(), saveDelayMs = SAVE_DELAY_MS} = {}) {
        this._history = history;
        this._file = Gio.File.new_for_path(path);
        this._saveDelayMs = saveDelayMs;
        this._saveId = 0;
        this._loaded = false;
        // Bumped by forget(), so a save already being written can tell that
        // its data is out of date.
        this._generation = 0;
        this._cancellable = new Gio.Cancellable();

        /** Resolves once the history has been read (or found missing). */
        this.loaded = this._load();
    }

    /** Save soon; several picks in a row are written once. */
    scheduleSave() {
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._saveDelayMs, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Clear the history, cancel any pending save and delete the file.
     *
     * @returns {Promise<void>}
     */
    async forget() {
        this._generation++;
        this._history.clear();
        this._cancelSave();
        try {
            await deleteFile(this._file);
        } catch (e) {
            console.error(`HighBeam: failed to delete history: ${e}`);
        }
    }

    /** Write any pending changes and stop. */
    destroy() {
        if (this._saveId) {
            this._cancelSave();
            this._save();
        }
        this._cancellable.cancel();
    }

    _cancelSave() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
    }

    async _load() {
        try {
            const contents = await loadContents(this._file, this._cancellable);
            this._history.load(JSON.parse(new TextDecoder().decode(contents)));
        } catch (e) {
            if (isError(e, Gio.IOErrorEnum.CANCELLED))
                return;
            // A missing file is normal (nothing learned yet); anything else
            // is logged, and the file is replaced at the next save.
            if (!isError(e, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`HighBeam: ignoring unreadable history: ${e}`);
        }
        this._loaded = true;
    }

    // Not cancelled by destroy(), so the last save on disable still lands.
    async _save() {
        // Never overwrite the file with an empty history before it has loaded.
        if (!this._loaded)
            return;
        const generation = this._generation;
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(this._history)));
        try {
            await makeDirectory(this._file.get_parent());
            await replaceContents(this._file, bytes);
            // Forgotten while this was being written: don't leave it behind.
            if (generation !== this._generation)
                await deleteFile(this._file);
        } catch (e) {
            console.error(`HighBeam: failed to save history: ${e}`);
        }
    }
}
