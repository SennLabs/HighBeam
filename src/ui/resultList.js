// SPDX-License-Identifier: GPL-2.0-or-later
//
// The scrolling list of results: an optional Top Hit, then one section per
// provider. Keyboard focus stays in the search entry; the list keeps its own
// selection, which the panel moves with the arrow keys.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const ICON_SIZE = 24;
const TOP_HIT_ICON_SIZE = 40;
const FALLBACK_ICON = 'text-x-generic-symbolic';
// Wait for results to stop streaming in before telling a screen reader which
// row is selected, so it isn't interrupted by every update.
const ANNOUNCE_DELAY_MS = 250;

function singleLine(text) {
    return (text ?? '').replace(/\s+/g, ' ').trim();
}

function makeLabel(text, styleClass) {
    const label = new St.Label({
        text,
        style_class: styleClass,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

export class ResultList {
    /**
     * @param {object} params
     * @param {(item: object, secondary: boolean) => void} params.onActivate
     *   item is `{result, provider}`
     * @param {(text: string) => void} params.onAnnounce speak `text` with a
     *   screen reader
     */
    constructor({onActivate, onAnnounce}) {
        this._onActivate = onActivate;
        this._onAnnounce = onAnnounce;
        this._announceId = 0;
        this._announced = '';

        this._box = new St.BoxLayout({
            style_class: 'highbeam-results-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            accessible_role: Atk.Role.LIST,
            accessible_name: _('Search results'),
        });

        this.actor = new St.ScrollView({
            style_class: 'highbeam-results',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._box,
        });
        this.actor.connect('destroy', () => this._cancelAnnounce());

        // [{actor, item, key}] in display order
        this._rows = [];
        this._selected = -1;
        // Once the user picks a row with the keyboard or mouse, keep it
        // selected while more results for the same query stream in.
        this._userSelected = false;
        this._query = '';
        this._iconScale = 1;
    }

    get isEmpty() {
        return this._rows.length === 0;
    }

    /** @returns {object|null} the selected `{result, provider, stale}` */
    get selectedItem() {
        return this._rows[this._selected]?.item ?? null;
    }

    /** Whether the user moved the selection since the query last changed. */
    get userSelected() {
        return this._userSelected;
    }

    /**
     * @param {number} scale icon size multiplier, follows the text size
     */
    setIconScale(scale) {
        this._iconScale = scale;
    }

    clear() {
        this._cancelAnnounce();
        this._announced = '';
        this._box.destroy_all_children();
        this._rows = [];
        this._selected = -1;
        this._userSelected = false;
    }

    /**
     * @param {import('../search/engine.js').Snapshot} snapshot
     */
    setResults({topHit, sections, terms}) {
        // A new query starts at the top again; the same query keeps the
        // user's pick while more results arrive.
        const query = terms.join(' ');
        const previousKey = this._userSelected && query === this._query
            ? this._rows[this._selected]?.key : null;
        this._query = query;

        this._box.destroy_all_children();
        this._rows = [];
        this._selected = -1;

        if (topHit) {
            this._addHeader(_('Top Hit'), null, terms);
            this._addRow({result: topHit, provider: topHit.provider}, true);
        }

        for (const {provider, results, stale} of sections) {
            this._addHeader(provider.name, provider, terms);
            for (const result of results)
                this._addRow({result, provider, stale}, false);
        }

        const kept = previousKey ? this._rows.findIndex(r => r.key === previousKey) : -1;
        if (kept >= 0) {
            this._select(kept);
        } else {
            this._userSelected = false;
            this._select(this._rows.length > 0 ? 0 : -1);
        }
    }

    moveSelection(delta) {
        if (this._rows.length === 0)
            return;
        const index = Math.max(0, Math.min(this._rows.length - 1, this._selected + delta));
        this._userSelected = true;
        this._select(index);
    }

    selectFirst() {
        this.moveSelection(-this._rows.length);
    }

    selectLast() {
        this.moveSelection(this._rows.length);
    }

    activateSelected(secondary = false) {
        this.activateIndex(this._selected, secondary);
    }

    activateIndex(index, secondary = false) {
        const row = this._rows[index];
        if (row)
            this._onActivate(row.item, secondary);
    }

    destroy() {
        this.actor.destroy();
        this._rows = [];
    }

    _addHeader(title, provider, terms) {
        const header = new St.BoxLayout({
            style_class: 'highbeam-section-header',
            x_expand: true,
            accessible_role: Atk.Role.HEADING,
            accessible_name: title,
        });
        header.add_child(makeLabel(title, 'highbeam-section-title'));

        if (provider?.canLaunchSearch) {
            const more = new St.Button({
                style_class: 'highbeam-show-more',
                label: _('Show More'),
                can_focus: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            more.connect('clicked', () => this._onActivate({provider, showMore: true, terms}, false));
            header.add_child(more);
        }

        this._box.add_child(header);
    }

    _addRow(item, isTopHit) {
        const {result, provider} = item;
        const iconSize = Math.round((isTopHit ? TOP_HIT_ICON_SIZE : ICON_SIZE) * this._iconScale);

        let icon = null;
        try {
            icon = result.createIcon(iconSize);
        } catch (e) {
            console.warn(`HighBeam: failed to create icon for ${result.id}: ${e}`);
        }
        icon ??= new St.Icon({icon_name: FALLBACK_ICON, icon_size: iconSize});

        const iconBin = new St.Bin({
            style_class: 'highbeam-row-icon',
            child: icon,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(makeLabel(singleLine(result.name), 'highbeam-row-title'));
        const description = singleLine(result.description);
        if (description)
            text.add_child(makeLabel(description, 'highbeam-row-subtitle'));

        const content = new St.BoxLayout({x_expand: true});
        content.add_child(iconBin);
        content.add_child(text);

        const name = singleLine(result.name);
        const actor = new St.Button({
            style_class: isTopHit ? 'highbeam-row highbeam-top-hit' : 'highbeam-row',
            child: content,
            can_focus: false,
            x_expand: true,
            accessible_role: Atk.Role.LIST_ITEM,
            accessible_name: isTopHit ? _('Top Hit: %s').format(name) : name,
        });
        if (description)
            actor.get_accessible()?.set_description(description);

        const index = this._rows.length;
        actor.connect('clicked', () => this.activateIndex(index));
        // Select on real pointer movement only. "hover" also changes when the
        // list is rebuilt under a still pointer, which would steal the selection.
        actor.connect('motion-event', () => {
            if (this._selected !== index) {
                this._userSelected = true;
                this._select(index);
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._box.add_child(actor);
        this._rows.push({actor, item, key: `${provider.id}:${result.id}`});
    }

    _select(index) {
        const previous = this._rows[this._selected]?.actor;
        previous?.remove_style_pseudo_class('selected');
        previous?.remove_accessible_state(Atk.StateType.SELECTED);
        this._selected = index;
        const row = this._rows[index];
        if (!row)
            return;
        row.actor.add_style_pseudo_class('selected');
        row.actor.add_accessible_state(Atk.StateType.SELECTED);
        ensureActorVisibleInScrollView(this.actor, row.actor);
        this._scheduleAnnounce();
    }

    // Keyboard focus stays in the search entry, so a screen reader doesn't
    // follow the selection by itself; describe the selected row instead.
    _scheduleAnnounce() {
        this._cancelAnnounce();
        this._announceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANNOUNCE_DELAY_MS, () => {
            this._announceId = 0;
            const row = this._rows[this._selected];
            // Nothing to say once the popup has closed.
            if (!row || !this.actor.mapped)
                return GLib.SOURCE_REMOVE;
            const description = singleLine(row.item.result.description);
            const label = description
                ? `${row.actor.accessible_name}, ${description}`
                : row.actor.accessible_name;
            const text = _('%s, %d of %d').format(label, this._selected + 1, this._rows.length);
            if (text !== this._announced) {
                this._announced = text;
                this._onAnnounce?.(text);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelAnnounce() {
        if (this._announceId) {
            GLib.source_remove(this._announceId);
            this._announceId = 0;
        }
    }
}
