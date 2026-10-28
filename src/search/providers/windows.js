// SPDX-License-Identifier: GPL-2.0-or-later
//
// Open windows on every workspace, matched by window title and app name.
// Activating one switches to it.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {score} from '../ranking.js';

// Same cut-off as fuzzy app matches: window titles are long, so weaker fuzzy
// matches are mostly noise.
const THRESHOLD = 0.35;

export class WindowsProvider {
    constructor(settings) {
        this.id = 'highbeam-windows';
        this.name = _('Windows');
        this.isRemote = false;
        this.canLaunchSearch = false;
        // An app result already focuses its open window, so let apps win ties.
        this.bias = 0;
        // Its result ids don't mean the same thing next time, so don't learn from picks.
        this.recordHistory = false;

        this._settings = settings;
        this._tracker = Shell.WindowTracker.get_default();
    }

    search(terms, _previousState, _cancellable) {
        const query = terms.join(' ');
        const max = this._settings.get_int('max-provider-results');
        const activeWorkspace = global.workspace_manager.get_active_workspace();

        const results = [];
        for (const window of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)) {
            const title = window.get_title() ?? '';
            const app = this._tracker.get_window_app(window);
            const appName = app?.get_name() ?? '';
            const value = Math.max(score(query, title), score(query, appName));
            if (value < THRESHOLD)
                continue;

            const workspace = window.get_workspace();
            let description = appName;
            // Say where the window is when switching to it changes workspace.
            if (workspace && workspace !== activeWorkspace && !window.is_on_all_workspaces()) {
                const where = _('Workspace %d').format(workspace.index() + 1);
                description = description ? `${description} · ${where}` : where;
            }

            results.push({
                id: String(window.get_id()),
                name: title || appName,
                description,
                createIcon: size => app?.create_icon_texture(size) ??
                    new St.Icon({icon_name: 'focus-windows-symbolic', icon_size: size}),
                score: value,
                window,
            });
        }

        // The tab list is most-recently-used first; the stable sort keeps
        // that order among equal scores.
        results.sort((a, b) => b.score - a.score);
        return Promise.resolve({state: null, results: results.slice(0, max)});
    }

    activate(result, _terms, _options) {
        // The window may have closed while the popup was open.
        if (result.window.get_compositor_private())
            Main.activateWindow(result.window);
    }
}
