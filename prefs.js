// SPDX-License-Identifier: GPL-2.0-or-later
//
// HighBeam's preferences window (Extensions app → HighBeam → Settings).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import GLib from 'gi://GLib';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TOGGLE_KEY = 'toggle-highbeam';
// Section ids in result-order, as in src/controller.js.
const DEFAULT_ORDER = ['calculator', 'apps', 'windows', 'gnome', 'web'];
// The setting that switches each optional section on or off.
const SECTION_SWITCHES = {
    calculator: 'enable-calculator',
    windows: 'enable-windows',
    web: 'enable-web-search',
};

export default class HighBeamPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // The window outlives this call; keep the settings object with it.
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const keyboard = new Adw.PreferencesGroup({title: _('Keyboard')});
        keyboard.add(new ShortcutRow({
            title: _('Open and close HighBeam'),
            settings,
            key: TOGGLE_KEY,
        }));
        page.add(keyboard);

        const popup = new Adw.PreferencesGroup({title: _('Popup')});
        popup.add(this._comboRow(settings, 'popup-monitor', _('Open on'), [
            ['cursor', _('Pointer’s monitor')],
            ['primary', _('Primary monitor')],
        ]));
        popup.add(this._switchRow(settings, 'remember-query',
            _('Remember last query'), _('Reopen with the previous search selected; typing replaces it')));
        popup.add(this._spinRow(settings, 'max-app-results',
            _('Application results'), _('Maximum number of apps shown')));
        popup.add(this._spinRow(settings, 'max-provider-results',
            _('Results per search provider'),
            _('From each GNOME provider (Files, Settings…), and open windows')));
        page.add(popup);

        window.add(this._appearancePage(settings));
        window.add(this._searchPage(settings));
    }

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        const style = new Adw.PreferencesGroup({title: _('Style')});
        style.add(this._comboRow(settings, 'theme', _('Theme'), [
            ['auto', _('Follow system style')],
            ['dark', _('Dark')],
            ['light', _('Light')],
        ]));
        style.add(this._spinRow(settings, 'background-opacity',
            _('Background opacity'), _('Percent; lower lets the blur show through'), 5));
        const blur = this._switchRow(settings, 'blur',
            _('Blur background'), _('Blur whatever is behind the popup'));
        style.add(blur);
        const blurRadius = this._spinRow(settings, 'blur-radius', _('Blur radius'), _('Pixels'));
        blur.bind_property('active', blurRadius, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        style.add(blurRadius);
        style.add(this._spinRow(settings, 'corner-radius', _('Corner radius'), _('Pixels')));
        page.add(style);

        const size = new Adw.PreferencesGroup({title: _('Size')});
        size.add(this._spinRow(settings, 'panel-width', _('Width'), _('Pixels'), 20));
        size.add(this._spinRow(settings, 'results-max-height',
            _('Result list height'), _('Maximum, in pixels; longer lists scroll'), 20));
        size.add(this._spinRow(settings, 'font-scale', _('Text size'), _('Percent'), 5));
        page.add(size);

        const reset = new Adw.PreferencesGroup();
        const resetButton = new Gtk.Button({
            label: _('Reset Appearance'),
            halign: Gtk.Align.CENTER,
            css_classes: ['pill'],
        });
        const appearanceKeys = ['theme', 'background-opacity', 'blur', 'blur-radius',
            'corner-radius', 'panel-width', 'results-max-height', 'font-scale'];
        resetButton.connect('clicked', () => appearanceKeys.forEach(key => settings.reset(key)));
        this._sensitiveWhenChanged(resetButton, settings, appearanceKeys);
        reset.add(resetButton);
        page.add(reset);

        return page;
    }

    _searchPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Search'),
            icon_name: 'system-search-symbolic',
        });

        const builtIn = new Adw.PreferencesGroup({
            title: _('Results'),
            description: _('Extra kinds of result HighBeam adds to the list'),
        });
        builtIn.add(this._switchRow(settings, 'enable-calculator',
            _('Calculator'), _('Answer sums like 2+2 or sqrt(2)*pi; Enter copies the answer')));
        builtIn.add(this._switchRow(settings, 'enable-windows',
            _('Open windows'), _('Switch to a window by its title or app')));
        builtIn.add(this._switchRow(settings, 'enable-system-actions',
            _('System actions'), _('Lock Screen, Log Out, Power Off… among the apps')));
        const web = this._switchRow(settings, 'enable-web-search',
            _('Web search'), _('“Search the web for …” as a result'));
        builtIn.add(web);
        page.add(builtIn);

        const webGroup = new Adw.PreferencesGroup({title: _('Web Search')});
        const url = new Adw.EntryRow({title: _('Search URL (%s is replaced by the query)')});
        settings.bind('web-search-url', url, 'text', Gio.SettingsBindFlags.DEFAULT);
        // Flag addresses that can't work: empty, or not a web address.
        const checkUrl = () => {
            const text = url.text.trim();
            if (text === '' || /\s/.test(text) || (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)))
                url.add_css_class('error');
            else
                url.remove_css_class('error');
        };
        url.connect('notify::text', checkUrl);
        checkUrl();
        web.bind_property('active', webGroup, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Reset to default'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => settings.reset('web-search-url'));
        this._sensitiveWhenChanged(reset, settings, ['web-search-url']);
        url.add_suffix(reset);
        webGroup.add(url);
        page.add(webGroup);

        const gnome = new Adw.PreferencesGroup({title: _('GNOME Search Providers')});
        const open = new Adw.ActionRow({
            title: _('Files, Settings, Characters…'),
            subtitle: _('Choose and reorder them in GNOME Settings → Search'),
            activatable: true,
        });
        open.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        open.connect('activated', () => {
            try {
                Gio.Subprocess.new(['gnome-control-center', 'search'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                console.error(`HighBeam: failed to open GNOME Settings: ${e}`);
            }
        });
        gnome.add(open);
        page.add(gnome);

        page.add(this._learningGroup(settings));
        page.add(new SectionOrderGroup(settings));

        return page;
    }

    _learningGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Ranking')});
        group.add(this._switchRow(settings, 'learn-from-selections',
            _('Learn from what you pick'),
            _('Results you chose before rank higher for the same or a similar search')));

        const forget = new Adw.ActionRow({
            title: _('Forget learned results'),
            subtitle: _('Clears the history; rankings go back to text matching only'),
        });
        const button = new Gtk.Button({
            label: _('Forget'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        button.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('Forget Learned Results?'),
                body: _('HighBeam will stop favouring the results you picked before. This can’t be undone.'),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('forget', _('Forget'));
            dialog.set_response_appearance('forget', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_d, response) => {
                if (response === 'forget')
                    this._forgetHistory(settings, button);
            });
            dialog.present(button);
        });
        forget.add_suffix(button);
        group.add(forget);
        return group;
    }

    // Enable `widget` (a reset button) only while some key differs from its default.
    _sensitiveWhenChanged(widget, settings, keys) {
        const sync = () => {
            widget.sensitive = keys.some(key => settings.get_user_value(key) !== null);
        };
        const ids = keys.map(key => settings.connect(`changed::${key}`, sync));
        widget.connect('destroy', () => ids.forEach(id => settings.disconnect(id)));
        sync();
    }

    _forgetHistory(settings, widget) {
        // The running extension clears its copy (and any save in progress)
        // when this key changes; deleting the file also covers the case
        // where HighBeam is turned off.
        settings.set_uint('forget-history', settings.get_uint('forget-history') + 1);
        const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'highbeam', 'history.json']);
        Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null, (file, res) => {
            let message = _('Learned results forgotten');
            try {
                file.delete_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                    console.error(`HighBeam: failed to delete history: ${e}`);
                    message = _('Could not delete the history file');
                }
            }
            widget.get_root()?.add_toast?.(new Adw.Toast({title: message}));
        });
    }

    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /**
     * A combo row for an enum key.
     *
     * @param {Gio.Settings} settings
     * @param {string} key
     * @param {string} title
     * @param {[string, string][]} choices [nick, label] in display order
     * @returns {Adw.ComboRow}
     */
    _comboRow(settings, key, title, choices) {
        const nicks = choices.map(([nick]) => nick);
        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(choices.map(([, label]) => label)),
        });
        const sync = () => {
            row.selected = Math.max(0, nicks.indexOf(settings.get_string(key)));
        };
        sync();
        const id = settings.connect(`changed::${key}`, sync);
        row.connect('destroy', () => settings.disconnect(id));
        row.connect('notify::selected', () => {
            const nick = nicks[row.selected];
            if (nick && settings.get_string(key) !== nick)
                settings.set_string(key, nick);
        });
        return row;
    }

    _spinRow(settings, key, title, subtitle, step = 1) {
        const range = settings.settings_schema.get_key(key).get_range().deep_unpack()[1].deep_unpack();
        const row = Adw.SpinRow.new_with_range(range[0], range[1], step);
        row.set({title, subtitle});
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}

/**
 * The result sections in the order they appear, with buttons to move each one
 * up or down. Stored in the result-order key.
 */
class SectionOrderGroup extends Adw.PreferencesGroup {
    static {
        GObject.registerClass({GTypeName: 'HighBeamSectionOrderGroup'}, this);
    }

    constructor(settings) {
        super({
            title: _('Section Order'),
            description: _('The Top Hit is always first, whatever the order'),
        });
        this._settings = settings;
        this._rows = [];

        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Reset to default'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => settings.reset('result-order'));
        this.header_suffix = reset;
        this._reset = reset;
        // The section to keep keyboard focus on after a move rebuilds the rows.
        this._focus = null;

        const ids = ['result-order', ...Object.values(SECTION_SWITCHES)].map(key =>
            settings.connect(`changed::${key}`, () => this._rebuild()));
        this.connect('destroy', () => ids.forEach(id => settings.disconnect(id)));
        this._rebuild();
    }

    _order() {
        // Same rule as the extension: the saved order, then anything missing.
        return [...new Set([...this._settings.get_strv('result-order'), ...DEFAULT_ORDER])]
            .filter(id => DEFAULT_ORDER.includes(id));
    }

    _rebuild() {
        const titles = {
            calculator: _('Calculator'),
            apps: _('Applications and system actions'),
            windows: _('Open windows'),
            gnome: _('GNOME search providers'),
            web: _('Web search'),
        };
        this._rows.forEach(row => this.remove(row));
        this._reset.sensitive = this._settings.get_user_value('result-order') !== null;
        const order = this._order();
        const focus = this._focus;
        this._focus = null;
        this._rows = order.map((id, index) => {
            const row = new Adw.ActionRow({title: titles[id]});
            const switchKey = SECTION_SWITCHES[id];
            if (switchKey && !this._settings.get_boolean(switchKey))
                row.subtitle = _('Switched off');
            else if (id === 'gnome')
                row.subtitle = _('In the order set in GNOME Settings → Search');
            const up = this._moveButton('go-up-symbolic', _('Move up'), index > 0,
                () => this._move(order, index, -1));
            const down = this._moveButton('go-down-symbolic', _('Move down'), index < order.length - 1,
                () => this._move(order, index, 1));
            row.add_suffix(up);
            row.add_suffix(down);
            this.add(row);
            // Keep focus on the moved section, so it can be moved again
            // from the keyboard; at the top or bottom, use the other button.
            if (focus?.id === id) {
                const wanted = focus.delta < 0 ? up : down;
                (wanted.sensitive ? wanted : wanted === up ? down : up).grab_focus();
            }
            return row;
        });
    }

    _moveButton(icon, tooltip, sensitive, onClicked) {
        const button = new Gtk.Button({
            icon_name: icon,
            tooltip_text: tooltip,
            sensitive,
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        button.connect('clicked', onClicked);
        return button;
    }

    _move(order, index, delta) {
        this._focus = {id: order[index], delta};
        const next = [...order];
        [next[index], next[index + delta]] = [next[index + delta], next[index]];
        this._settings.set_strv('result-order', next);
    }
}

/**
 * A row showing a keyboard shortcut stored in an `as` settings key. Clicking
 * it asks for a new shortcut; the reset button restores the default.
 */
class ShortcutRow extends Adw.ActionRow {
    static {
        GObject.registerClass({GTypeName: 'HighBeamShortcutRow'}, this);
    }

    constructor({title, settings, key}) {
        super({title, activatable: true});
        this._settings = settings;
        this._key = key;

        this._label = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);

        this._reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Reset to default'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._reset.connect('clicked', () => settings.reset(key));
        this.add_suffix(this._reset);

        this.connect('activated', () => this._capture());

        const id = settings.connect(`changed::${key}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(id));
        this._sync();
    }

    _sync() {
        const accel = this._settings.get_strv(this._key)[0] ?? '';
        this._label.accelerator = accel;
        this._reset.sensitive = this._settings.get_user_value(this._key) !== null;
    }

    // GNOME (or another shortcut) may already use this combination, in which
    // case pressing it won't reach HighBeam. Say so, rather than fail quietly.
    _warnIfTaken(keyval, mask) {
        const owner = findShortcutOwner(keyval, mask);
        if (!owner)
            return;
        const label = Gtk.accelerator_get_label(keyval, mask);
        this.get_root()?.add_toast?.(new Adw.Toast({
            title: _('%s is also a GNOME shortcut (%s); it may not reach HighBeam').format(label, owner),
            timeout: 8,
        }));
    }

    _capture() {
        const dialog = new Adw.AlertDialog({
            heading: _('Set Shortcut'),
            body: _('Press the new shortcut for “%s”.\nEsc cancels, Backspace disables it.')
                .format(this.title),
        });
        dialog.add_response('cancel', _('Cancel'));

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            let mask = state & Gtk.accelerator_get_default_mod_mask();
            mask &= ~Gdk.ModifierType.LOCK_MASK;
            keyval = Gdk.keyval_to_lower(keyval);

            if (mask === 0 && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (mask === 0 && keyval === Gdk.KEY_BackSpace) {
                this._settings.set_strv(this._key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Wait for the non-modifier key; a bare letter would make
            // ordinary typing open the popup, so require a modifier.
            if (isModifier(keyval) || !Gtk.accelerator_valid(keyval, mask))
                return Gdk.EVENT_STOP;
            // Shift alone isn't enough either: Shift+A is just a capital A.
            if ((mask & ~Gdk.ModifierType.SHIFT_MASK) === 0 && !isFunctionKey(keyval))
                return Gdk.EVENT_STOP;

            const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
            this._settings.set_strv(this._key, [accel]);
            dialog.close();
            this._warnIfTaken(keyval, mask);
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);

        // Otherwise the shell handles combos like Super+A, or the current
        // HighBeam shortcut, before this window sees them. GNOME Shell may
        // ask once whether to allow this.
        const surface = this.get_root()?.get_surface();
        surface?.inhibit_system_shortcuts(null);
        dialog.connect('closed', () => surface?.restore_system_shortcuts());

        dialog.present(this);
    }
}

// Where GNOME keeps the keyboard shortcuts that could clash with ours.
const SHORTCUT_SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
];

/**
 * @param {number} keyval
 * @param {number} mask
 * @returns {string|null} the name of a GNOME setting already using this
 *   shortcut, if any
 */
function findShortcutOwner(keyval, mask) {
    const source = Gio.SettingsSchemaSource.get_default();
    for (const id of SHORTCUT_SCHEMAS) {
        const schema = source.lookup(id, true);
        if (!schema)
            continue;
        const settings = new Gio.Settings({settings_schema: schema});
        for (const key of schema.list_keys()) {
            if (schema.get_key(key).get_value_type().dup_string() !== 'as')
                continue;
            for (const accel of settings.get_strv(key)) {
                const [ok, otherKeyval, otherMask] = Gtk.accelerator_parse(accel);
                if (ok && otherKeyval === keyval && otherMask === mask)
                    return key;
            }
        }
    }
    return null;
}

/**
 * @param {number} keyval
 * @returns {boolean} whether the key is only a modifier (Ctrl, Super, …)
 */
function isModifier(keyval) {
    return [
        Gdk.KEY_Control_L, Gdk.KEY_Control_R,
        Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
        Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
        Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
        Gdk.KEY_Super_L, Gdk.KEY_Super_R,
        Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
        Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_Caps_Lock,
    ].includes(keyval);
}

/**
 * @param {number} keyval
 * @returns {boolean} whether the key is F1…F35, usable without a modifier
 */
function isFunctionKey(keyval) {
    return keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;
}
