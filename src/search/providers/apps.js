// SPDX-License-Identifier: GPL-2.0-or-later
//
// Installed applications, plus GNOME's system actions (Lock Screen, Power Off,
// Settings…) the same way the Overview search offers them.

import Shell from 'gi://Shell';
import St from 'gi://St';

import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Score, score} from '../ranking.js';

// Shell.AppSystem.search() also matches generic names, keywords and
// categories ("browser" → Firefox), which our name scoring cannot see. Results
// in its earlier groups are better matches, so give them a floor score. The
// floor stays below the Top Hit threshold: an app whose name doesn't match the
// query is listed, but never promoted to Top Hit.
const groupFloor = groupIndex => Math.max(Score.FUZZY_MIN, Score.SUBSTRING - 0.05 - 0.1 * groupIndex);

// Minimum score for fuzzy name matches that Shell.AppSystem.search() missed
// (e.g. "lbo" → LibreOffice).
const FUZZY_THRESHOLD = 0.35;

export class AppsProvider {
    constructor(settings) {
        this.id = 'highbeam-apps';
        this.name = _('Applications');
        this.isRemote = false;
        this.canLaunchSearch = false;
        // Apps win a tie for Top Hit against files, settings, etc.
        this.bias = 0.05;

        this._settings = settings;
        this._appSystem = Shell.AppSystem.get_default();
        this._usage = Shell.AppUsage.get_default();
        this._parentalControls = ParentalControlsManager.getDefault();
        this._systemActions = SystemActions.getDefault();
    }

    search(terms, _previousState, _cancellable) {
        const query = terms.join(' ');
        const max = this._settings.get_int('max-app-results');

        const candidates = new Map();
        const add = (app, value) => {
            const id = app.get_id();
            if (!this._shouldShow(app))
                return;
            if ((candidates.get(id)?.score ?? -1) < value)
                candidates.set(id, {app, score: value});
        };

        Shell.AppSystem.search(query).forEach((group, groupIndex) => {
            for (const appId of group) {
                const app = this._appSystem.lookup_app(appId);
                if (app)
                    add(app, Math.max(score(query, app.get_name()), groupFloor(groupIndex)));
            }
        });

        if (candidates.size < max) {
            for (const app of this._appSystem.get_installed()) {
                if (!app.should_show())
                    continue;
                const value = score(query, app.get_name());
                if (value < FUZZY_THRESHOLD)
                    continue;
                const shellApp = this._appSystem.lookup_app(app.get_id());
                if (shellApp)
                    add(shellApp, value);
            }
        }

        const apps = [...candidates.values()]
            .sort((a, b) => b.score - a.score ||
                this._usage.compare(a.app.get_id(), b.app.get_id()))
            .map(({app, score: value}) => ({
                id: app.get_id(),
                name: app.get_name(),
                description: app.get_description() ?? '',
                createIcon: size => app.create_icon_texture(size),
                score: value,
                app,
            }));

        const matchingActions = this._settings.get_boolean('enable-system-actions')
            ? this._systemActions.getMatchingActions(terms)
            : [];
        const actions = matchingActions.map(id => {
            const name = this._systemActions.getName(id);
            const iconName = this._systemActions.getIconName(id);
            return {
                id,
                name,
                description: _('System Action'),
                createIcon: size => new St.Icon({icon_name: iconName, icon_size: size}),
                // Matched on a keyword if the name doesn't match ("shutdown" → Power Off).
                score: Math.max(score(query, name), groupFloor(1)),
                isSystemAction: true,
            };
        });

        const results = [...apps, ...actions]
            .sort((a, b) => b.score - a.score)
            .slice(0, max);

        return Promise.resolve({state: null, results});
    }

    activate(result, _terms, {secondary = false} = {}) {
        if (result.isSystemAction) {
            this._systemActions.activateAction(result.id);
            return;
        }

        if (secondary && result.app.can_open_new_window())
            result.app.open_new_window(-1);
        else
            result.app.activate();
    }

    _shouldShow(app) {
        if (!this._parentalControls.initialized)
            return true;
        return this._parentalControls.shouldShowApp(app.app_info);
    }
}
