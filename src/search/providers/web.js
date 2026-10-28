// SPDX-License-Identifier: GPL-2.0-or-later
//
// A "Search the web for …" row at the bottom of every result list. The URL
// comes from the web-search-url setting, with %s replaced by the query.

import Gio from 'gi://Gio';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Score} from '../ranking.js';

const URL_KEY = 'web-search-url';

/**
 * @param {string} template URL with %s where the query goes; without %s the
 *   query is appended
 * @param {string} query
 * @returns {string}
 */
function searchUrl(template, query) {
    // "duckduckgo.com/?q=%s" means https; without a scheme nothing opens it.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(template))
        template = `https://${template}`;
    const encoded = encodeURIComponent(query);
    return template.includes('%s')
        ? template.replaceAll('%s', encoded)
        : template + encoded;
}

function hostOf(template) {
    return /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]+)/i.exec(template)?.[1].replace(/^www\./, '') ?? '';
}

export class WebSearchProvider {
    constructor(settings) {
        this.id = 'highbeam-web';
        this.name = _('Web');
        this.isRemote = false;
        this.canLaunchSearch = false;
        this.bias = 0;
        // Only a last resort: Enter waits briefly for other results first.
        this.isFallback = true;
        // Its result ids don't mean the same thing next time, so don't learn from picks.
        this.recordHistory = false;

        this._settings = settings;
    }

    search(terms, _previousState, _cancellable) {
        const template = this._settings.get_string(URL_KEY).trim();
        if (!template)
            return Promise.resolve({state: null, results: []});

        const query = terms.join(' ');
        return Promise.resolve({
            state: null,
            results: [{
                id: 'web',
                name: _('Search the web for “%s”').format(query),
                description: hostOf(template),
                createIcon: size => new St.Icon({icon_name: 'web-browser-symbolic', icon_size: size}),
                // Never the Top Hit; only selected first when nothing else matched.
                score: Score.NONE,
                url: searchUrl(template, query),
            }],
        });
    }

    activate(result, _terms, _options) {
        const context = global.create_app_launch_context(0, -1);
        Gio.AppInfo.launch_default_for_uri_async(result.url, context, null, (_o, res) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(res);
            } catch (e) {
                // Not the URL: it contains what the user searched for.
                console.error(`HighBeam: failed to open the web search: ${e}`);
            }
        });
    }
}
