// SPDX-License-Identifier: GPL-2.0-or-later
//
// The popup itself: a search entry above the result list. Keyboard focus
// always stays in the entry, and this class turns key presses into list
// navigation and activation.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ResultList} from './resultList.js';

const PAGE_STEP = 5;

// Panel background colour for each theme; the alpha comes from the settings.
const BACKGROUNDS = {
    dark: [36, 36, 40],
    light: [250, 250, 252],
};
// The stylesheet's font sizes are in em of this, scaled by the text-size setting.
const BASE_FONT_PT = 10;
// The search icon's size at 100% text size.
const ENTRY_ICON_SIZE = 22;

const DIGIT_KEYS = [
    Clutter.KEY_1, Clutter.KEY_2, Clutter.KEY_3,
    Clutter.KEY_4, Clutter.KEY_5, Clutter.KEY_6,
    Clutter.KEY_7, Clutter.KEY_8, Clutter.KEY_9,
];

export class Panel {
    /**
     * @param {object} callbacks
     * @param {(text: string) => void} callbacks.onQueryChanged
     * @param {(secondary: boolean, index: number|null) => void} callbacks.onActivateRequested
     *   Enter (index null = the selected row) or Ctrl+1…9
     * @param {(item: object, secondary: boolean) => void} callbacks.onActivate
     *   a row was clicked
     * @param {() => void} callbacks.onClose
     */
    constructor({onQueryChanged, onActivateRequested, onActivate, onClose}) {
        this._onActivateRequested = onActivateRequested;
        this._onClose = onClose;

        this.actor = new St.BoxLayout({
            name: 'highbeamPanel',
            style_class: 'highbeam-panel',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            accessible_role: Atk.Role.DIALOG,
            accessible_name: 'HighBeam',
        });

        this.entry = new St.Entry({
            style_class: 'highbeam-entry',
            hint_text: _('HighBeam Search'),
            can_focus: true,
            x_expand: true,
            accessible_name: _('Search'),
        });
        this._entryIcon = new St.Icon({
            style_class: 'highbeam-entry-icon',
            icon_name: 'edit-find-symbolic',
        });
        this.entry.set_primary_icon(this._entryIcon);
        this.entry.clutter_text.connect('text-changed',
            () => onQueryChanged(this.entry.get_text()));
        this.entry.clutter_text.connect('key-press-event',
            (_actor, event) => this._onKeyPress(event));
        this.actor.add_child(this.entry);

        this._separator = new St.Widget({style_class: 'highbeam-separator', visible: false});
        this.actor.add_child(this._separator);

        this.list = new ResultList({onActivate, onAnnounce: text => this._announce(text)});
        this.list.actor.visible = false;
        this.actor.add_child(this.list.actor);

        // Blurs what is behind the panel, on the GPU.
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, enabled: false});
        this.actor.add_effect_with_name('highbeam-blur', this._blur);
    }

    /**
     * Apply the appearance settings.
     *
     * @param {object} appearance
     * @param {'dark'|'light'} appearance.theme
     * @param {number} appearance.width popup width in px
     * @param {number} appearance.maxHeight result list max height in px
     * @param {number} appearance.fontScale text size in percent
     * @param {number} appearance.radius corner radius in px
     * @param {number} appearance.opacity background opacity in percent
     * @param {boolean} appearance.blur
     * @param {number} appearance.blurRadius in px
     */
    setAppearance({theme, width, maxHeight, fontScale, radius, opacity, blur, blurRadius}) {
        if (theme === 'light')
            this.actor.add_style_class_name('highbeam-light');
        else
            this.actor.remove_style_class_name('highbeam-light');

        this._blur.radius = blurRadius;
        this._blur.enabled = blur;

        this._appearance = {theme, width, maxHeight, fontScale, radius, opacity};
        this._limits ??= {maxWidth: Infinity, maxListHeight: Infinity};
        this._applyStyle();
    }

    /**
     * Keep the panel within the screen: never wider or the list taller than
     * these, whatever the settings say.
     *
     * @param {object} limits
     * @param {number} limits.maxWidth in px
     * @param {number} limits.maxListHeight in px
     */
    fit(limits) {
        this._limits = limits;
        this._applyStyle();
    }

    _applyStyle() {
        const {theme, width, maxHeight, fontScale, radius, opacity} = this._appearance;
        const {maxWidth, maxListHeight} = this._limits;
        const [r, g, b] = BACKGROUNDS[theme] ?? BACKGROUNDS.dark;
        this.actor.style = [
            `width: ${Math.min(width, maxWidth)}px`,
            `border-radius: ${radius}px`,
            `font-size: ${(BASE_FONT_PT * fontScale / 100).toFixed(2)}pt`,
            `background-color: rgba(${r}, ${g}, ${b}, ${(opacity / 100).toFixed(2)})`,
        ].join('; ');
        this.list.actor.style = `max-height: ${Math.min(maxHeight, maxListHeight)}px`;
        this._entryIcon.style = `icon-size: ${Math.round(ENTRY_ICON_SIZE * fontScale / 100)}px`;
        this.list.setIconScale(fontScale / 100);
    }

    /**
     * Clear the query and results, ready to be shown again.
     *
     * @param {object} [params]
     * @param {boolean} [params.keepQuery] keep the previous query, selected so
     *   typing replaces it
     */
    reset({keepQuery = false} = {}) {
        this.setResults(null);
        if (!keepQuery) {
            this.entry.set_text('');
            return;
        }
        this.entry.clutter_text.set_selection(0, -1);
    }

    focus() {
        this.entry.grab_key_focus();
    }

    /**
     * @param {import('../search/engine.js').Snapshot|null} snapshot
     */
    setResults(snapshot) {
        if (snapshot)
            this.list.setResults(snapshot);
        else
            this.list.clear();

        const hasResults = !this.list.isEmpty;
        this._separator.visible = hasResults;
        this.list.actor.visible = hasResults;
    }

    destroy() {
        this.actor.destroy();
    }

    // Spoken by screen readers (Orca) as a polite announcement. The entry
    // has keyboard focus, so announce from there.
    _announce(text) {
        try {
            this.entry.get_accessible()?.emit('notification', text, Atk.Live.POLITE);
        } catch (e) {
            console.warn(`HighBeam: screen reader announcement failed: ${e}`);
        }
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

        switch (symbol) {
        case Clutter.KEY_Escape:
            // Like Spotlight: the first Escape clears the query, the second closes.
            if (this.entry.get_text() !== '') {
                // Drop the selection first, or a remembered query's
                // select-all outlives the text and eats the next keystroke.
                this.entry.clutter_text.set_selection(-1, -1);
                this.entry.set_text('');
            } else {
                this._onClose();
            }
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
            this.list.moveSelection(1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
            this.list.moveSelection(-1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Tab:
            this.list.moveSelection(shift ? -1 : 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_ISO_Left_Tab:
            this.list.moveSelection(-1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Page_Down:
        case Clutter.KEY_KP_Page_Down:
            this.list.moveSelection(PAGE_STEP);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Page_Up:
        case Clutter.KEY_KP_Page_Up:
            this.list.moveSelection(-PAGE_STEP);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._onActivateRequested(ctrl || alt, null);
            return Clutter.EVENT_STOP;
        }

        if (ctrl) {
            const digit = DIGIT_KEYS.indexOf(symbol);
            if (digit >= 0) {
                this._onActivateRequested(false, digit);
                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }
}
