// SPDX-License-Identifier: GPL-2.0-or-later
//
// GNOME's D-Bus search providers (Files, Settings, Calculator, Characters…).
//
// GNOME Shell's remoteSearch.js already reads the provider .ini files and
// applies the user's Search settings (enabled/disabled, sort order,
// "disable-external"). We wrap each provider in HighBeam's provider interface.
// remoteSearch.js is internal to GNOME Shell, so all use of it lives here.

import St from 'gi://St';

import * as RemoteSearch from 'resource:///org/gnome/shell/ui/remoteSearch.js';

import {evaluate} from '../calculator.js';
import {score} from '../ranking.js';

// GNOME Calculator's provider repeats the answer HighBeam's own calculator
// already shows as the Top Hit, so it is quiet for those queries.
const GNOME_CALCULATOR = 'org.gnome.Calculator.desktop';

class RemoteProvider {
    constructor(remote, settings) {
        this._remote = remote;
        this._settings = settings;

        this.id = `remote:${remote.id}`;
        this.name = remote.appInfo.get_name();
        this.isRemote = true;
        this.canLaunchSearch = remote.canLaunchSearch;
        this.bias = 0;
    }

    async search(terms, previousIds, cancellable) {
        if (this._remote.id === GNOME_CALCULATOR && this._settings.get_boolean('enable-calculator') &&
            evaluate(terms.join(' ')) !== null)
            return {state: null, results: []};

        // On failure the shell's provider logs and returns [], so a broken
        // provider only empties its own section.
        const ids = previousIds
            ? await this._remote.getSubsearchResultSet(previousIds, terms, cancellable)
            : await this._remote.getInitialResultSet(terms, cancellable);

        const max = this._settings.get_int('max-provider-results');
        const shown = this._remote.filterResults(ids, max);
        if (shown.length === 0)
            return {state: ids, results: []};

        const metas = await this._remote.getResultMetas(shown, cancellable);
        const query = terms.join(' ');
        const results = metas.map(meta => ({
            id: meta.id,
            name: meta.name ?? '',
            description: meta.description ?? '',
            createIcon: size => meta.createIcon(size) ?? this._createAppIcon(size),
            score: score(query, meta.name ?? ''),
        }));

        return {state: ids, results};
    }

    activate(result, terms, {secondary = false} = {}) {
        if (secondary && this.canLaunchSearch)
            this.launchSearch(terms);
        else
            this._remote.activateResult(result.id, terms);
    }

    launchSearch(terms) {
        this._remote.launchSearch(terms);
    }

    // Used when a result has no icon of its own: show the provider's app icon.
    _createAppIcon(size) {
        const gicon = this._remote.appInfo.get_icon();
        return gicon ? new St.Icon({gicon, icon_size: size}) : null;
    }
}

/**
 * @param {Gio.Settings} searchSettings org.gnome.desktop.search-providers
 * @param {Gio.Settings} settings HighBeam's own settings
 * @returns {RemoteProvider[]} providers in the user's sort order
 */
export function loadRemoteProviders(searchSettings, settings) {
    return RemoteSearch.loadRemoteSearchProviders(searchSettings)
        .map(remote => new RemoteProvider(remote, settings));
}
