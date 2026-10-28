// SPDX-License-Identifier: GPL-2.0-or-later
//
// Owns everything HighBeam adds to the shell: the hotkey, the popup actors and
// the search engine. Created in enable() and destroyed in disable().

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SearchEngine} from './search/engine.js';
import {History, resultKey} from './search/history.js';
import {AppsProvider} from './search/providers/apps.js';
import {CalculatorProvider} from './search/providers/calculator.js';
import {loadRemoteProviders} from './search/providers/remote.js';
import {WebSearchProvider} from './search/providers/web.js';
import {WindowsProvider} from './search/providers/windows.js';
import {Panel} from './ui/panel.js';
import {HistoryFile} from './util/historyFile.js';

const TOGGLE_KEY = 'toggle-highbeam';
const SEARCH_PROVIDERS_SCHEMA = 'org.gnome.desktop.search-providers';
// Settings that change which built-in providers run, or their order.
const PROVIDER_KEYS = ['enable-calculator', 'enable-windows', 'enable-web-search', 'result-order'];
const APPEARANCE_KEYS = [
    'theme', 'panel-width', 'results-max-height', 'font-scale',
    'corner-radius', 'background-opacity', 'blur', 'blur-radius',
];
// Section ids in result-order; 'gnome' stands for all of GNOME's providers.
const DEFAULT_ORDER = ['calculator', 'apps', 'windows', 'gnome', 'web'];

// The panel's top edge sits this far down the monitor, like Spotlight.
const TOP_OFFSET = 0.2;
const SHOW_DURATION_MS = 120;
const HIDE_DURATION_MS = 100;
const SHOW_SCALE = 0.97;
// Space kept between the popup and the edges of the screen.
const SCREEN_MARGIN = 24;
// The list never shrinks below this to fit a small screen.
const MIN_LIST_HEIGHT = 120;
// How long Enter waits for GNOME's providers when the selected row is stale
// or only the web search fallback.
const ENTER_WAIT_MS = 600;

export class Controller {
    /**
     * @param {Gio.Settings} settings HighBeam's settings
     */
    constructor(settings) {
        this._settings = settings;
        this._visible = false;
        // The monitor the popup opened on, for re-centring it when its width
        // changes while open.
        this._shownMonitor = null;
        this._grab = null;
        this._activating = false;

        // A transparent actor covering the whole stage. It holds the modal
        // grab, so a click anywhere outside the panel lands here and closes
        // the popup.
        this._backdrop = new St.Widget({
            name: 'highbeamBackdrop',
            reactive: true,
            visible: false,
        });
        // Always the size of the whole stage (all monitors), like GNOME's
        // own modal dialogs.
        this._backdrop.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        // Clicks inside the panel must propagate: stopping the press here
        // would cancel the click on the result row underneath.
        this._backdrop.connect('button-press-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            const panel = this._panel.actor;
            const [px, py] = panel.get_transformed_position();
            const [pw, ph] = panel.get_transformed_size();
            if (x >= px && x < px + pw && y >= py && y < py + ph)
                return Clutter.EVENT_PROPAGATE;
            this.hide();
            return Clutter.EVENT_STOP;
        });
        Main.layoutManager.addTopChrome(this._backdrop);

        this._panel = new Panel({
            onQueryChanged: text => this._engine.setQuery(text),
            onActivateRequested: (secondary, index) => this._onActivateRequested(secondary, index),
            onActivate: (item, secondary) => this._activate(item, secondary),
            onClose: () => this.hide(),
        });
        this._backdrop.add_child(this._panel.actor);

        this._history = new History();
        this._historyFile = new HistoryFile(this._history);
        this._engine = new SearchEngine(snapshot => this._panel.setResults(snapshot), {
            boosts: terms => this._learning() ? this._history.boosts(terms.join(' ')) : null,
        });
        this._calculatorProvider = new CalculatorProvider();
        this._appsProvider = new AppsProvider(settings);
        this._windowsProvider = new WindowsProvider(settings);
        this._webSearchProvider = new WebSearchProvider(settings);
        this._remoteProviders = null;
        this._providersChanged = true;

        // Reload GNOME's search providers when the user changes them in
        // Settings → Search. They are (re)loaded lazily on the next show().
        this._searchSettings = new Gio.Settings({schema_id: SEARCH_PROVIDERS_SCHEMA});
        this._searchSettings.connectObject('changed', () => {
            this._remoteProviders = null;
            this._invalidateProviders();
        }, this);
        settings.connectObject(
            'changed::forget-history', () => this._historyFile.forget(),
            ...PROVIDER_KEYS.flatMap(key => [`changed::${key}`, () => this._invalidateProviders()]),
            ...APPEARANCE_KEYS.flatMap(key => [`changed::${key}`, () => this._applyAppearance()]),
            this);
        // For the "auto" theme.
        St.Settings.get().connectObject('notify::color-scheme', () => this._applyAppearance(), this);
        this._applyAppearance();

        Main.wm.addKeybinding(TOGGLE_KEY, settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            // POPUP is the mode while HighBeam itself is open, so the hotkey
            // also closes it.
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this.toggle());

        Main.overview.connectObject('showing', () => this.hide({animate: false}), this);
        Main.layoutManager.connectObject('monitors-changed', () => this.hide({animate: false}), this);
        global.display.connectObject('in-fullscreen-changed', () => this.hide(), this);
    }

    toggle() {
        if (this._visible)
            this.hide();
        else
            this.show();
    }

    show() {
        if (this._visible)
            return;

        if (Main.overview.visible)
            Main.overview.hide();

        this._ensureProviders();
        const keepQuery = this._settings.get_boolean('remember-query');
        this._panel.reset({keepQuery});
        // hide() reset the engine, so search the remembered query again.
        if (keepQuery)
            this._engine.setQuery(this._panel.entry.get_text());

        this._shownMonitor = this._monitor();

        // Mark visible before stopping a running fade-out, so its onStopped
        // handler doesn't hide the backdrop we are about to show.
        this._visible = true;
        const panel = this._panel.actor;
        panel.remove_all_transitions();
        this._backdrop.reactive = true;
        this._backdrop.show();
        this._place();

        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        this._panel.focus();

        // ease() skips the animation when the user has turned animations off.
        panel.set_pivot_point(0.5, 0);
        panel.opacity = 0;
        panel.scale_x = panel.scale_y = SHOW_SCALE;
        panel.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: SHOW_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /**
     * @param {object} [params]
     * @param {boolean} [params.animate] fade out (default) or vanish at once,
     *   e.g. when an app is launching and the popup must not cover it
     */
    hide({animate = true} = {}) {
        if (!this._visible)
            return;
        this._visible = false;
        this._activating = false;

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._engine.reset();

        // The fading popup must not react to clicks any more.
        this._backdrop.reactive = false;
        const panel = this._panel.actor;
        panel.remove_all_transitions();
        if (!animate) {
            this._backdrop.hide();
            return;
        }
        panel.ease({
            opacity: 0,
            duration: HIDE_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (this._visible)
                    return;
                this._backdrop.hide();
                // Free the rows (and any windows they refer to) while hidden.
                this._panel.setResults(null);
            },
        });
    }

    destroy() {
        Main.wm.removeKeybinding(TOGGLE_KEY);
        this.hide({animate: false});

        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        St.Settings.get().disconnectObject(this);
        this._searchSettings.disconnectObject(this);
        this._searchSettings = null;
        this._settings.disconnectObject(this);

        this._engine.destroy();
        this._engine = null;
        this._historyFile.destroy();
        this._historyFile = null;
        this._history = null;
        this._remoteProviders = null;
        this._calculatorProvider = null;
        this._appsProvider = null;
        this._windowsProvider = null;
        this._webSearchProvider = null;

        // Destroying a chrome actor also untracks it from the layout manager.
        this._backdrop.destroy();
        this._backdrop = null;
        this._panel = null;
        this._settings = null;
    }

    // A provider was switched on or off: apply it now if the popup is open,
    // otherwise on the next show().
    _invalidateProviders() {
        this._providersChanged = true;
        if (this._visible)
            this._ensureProviders();
    }

    _ensureProviders() {
        if (!this._remoteProviders) {
            try {
                this._remoteProviders = loadRemoteProviders(this._searchSettings, this._settings);
            } catch (e) {
                console.error(`HighBeam: failed to load search providers: ${e}`);
                this._remoteProviders = [];
            }
            this._providersChanged = true;
        }
        if (!this._providersChanged)
            return;
        this._providersChanged = false;

        const enabled = key => this._settings.get_boolean(key);
        const sections = {
            calculator: enabled('enable-calculator') ? [this._calculatorProvider] : [],
            apps: [this._appsProvider],
            windows: enabled('enable-windows') ? [this._windowsProvider] : [],
            gnome: this._remoteProviders,
            web: enabled('enable-web-search') ? [this._webSearchProvider] : [],
        };
        // The user's order, then anything it leaves out. The Top Hit is
        // picked across all sections regardless of order.
        const order = [...new Set([...this._settings.get_strv('result-order'), ...DEFAULT_ORDER])];
        this._engine.setProviders(order.flatMap(id => sections[id] ?? []));
    }

    _applyAppearance() {
        const s = this._settings;
        let theme = s.get_string('theme');
        if (theme === 'auto')
            theme = St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_DARK ? 'dark' : 'light';

        this._panel.setAppearance({
            theme,
            width: s.get_int('panel-width'),
            maxHeight: s.get_int('results-max-height'),
            fontScale: s.get_int('font-scale'),
            radius: s.get_int('corner-radius'),
            opacity: s.get_int('background-opacity'),
            blur: s.get_boolean('blur'),
            blurRadius: s.get_int('blur-radius'),
        });
        if (this._visible)
            this._place();
    }

    // Centre the panel horizontally on the monitor it opened on, near the top.
    // Centre the panel on the monitor it opened on, near the top, shrinking
    // it if the configured size doesn't fit the screen.
    _place() {
        const monitor = this._shownMonitor;
        const work = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const panel = this._panel.actor;

        const y = Math.max(work.y + SCREEN_MARGIN, monitor.y + Math.floor(monitor.height * TOP_OFFSET));
        const [, entryHeight] = this._panel.entry.get_preferred_height(-1);
        // Entry plus the panel's padding, border and separator.
        const chrome = entryHeight + 32;
        this._panel.fit({
            maxWidth: work.width - 2 * SCREEN_MARGIN,
            maxListHeight: Math.max(MIN_LIST_HEIGHT, work.y + work.height - SCREEN_MARGIN - y - chrome),
        });

        // The width is known once the panel is on stage and styled.
        const [, width] = panel.get_preferred_width(-1);
        const x = Math.min(Math.max(work.x + Math.floor((work.width - width) / 2), work.x),
            work.x + work.width - width);
        panel.set_position(x, y);
    }

    _monitor() {
        const layout = Main.layoutManager;
        if (this._settings.get_string('popup-monitor') === 'cursor') {
            const index = global.display.get_current_monitor();
            if (layout.monitors[index])
                return layout.monitors[index];
        }
        return layout.primaryMonitor;
    }

    async _onActivateRequested(secondary, index) {
        if (this._activating)
            return;
        this._activating = true;
        try {
            // If Enter comes before the app results for the latest keystroke,
            // wait for them so we don't launch the result for an older query.
            await this._engine.whenLocalReady();
            // If what would open is left over from a shorter query, or only
            // the web search, give GNOME's providers a moment to answer.
            const item = this._panel.list.selectedItem;
            if (index === null && item && !this._panel.list.userSelected &&
                (item.stale || item.provider.isFallback) && this._engine.isSearching)
                await this._engine.whenSettled(ENTER_WAIT_MS);
        } finally {
            this._activating = false;
        }
        if (!this._visible)
            return;

        if (index === null)
            this._panel.list.activateSelected(secondary);
        else
            this._panel.list.activateIndex(index, secondary);
    }

    _activate(item, secondary) {
        const terms = item.terms ?? this._engine.terms;
        this.hide({animate: false});
        try {
            if (item.showMore)
                item.provider.launchSearch(terms);
            else
                item.provider.activate(item.result, terms, {secondary});
        } catch (e) {
            console.error(`HighBeam: failed to activate result: ${e}`);
        }
        if (!item.showMore)
            this._learn(terms, item);
    }

    _learning() {
        return this._settings.get_boolean('learn-from-selections');
    }

    _learn(terms, {provider, result}) {
        if (!this._learning() || provider.recordHistory === false || terms.length === 0)
            return;
        this._history.record(terms.join(' '), resultKey(provider.id, result.id));
        this._historyFile.scheduleSave();
    }
}
