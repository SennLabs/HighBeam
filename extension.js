// SPDX-License-Identifier: GPL-2.0-or-later
//
// HighBeam: a Spotlight-style search popup for GNOME Shell.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Controller} from './src/controller.js';

export default class HighBeamExtension extends Extension {
    enable() {
        this._controller = new Controller(this.getSettings());
    }

    disable() {
        this._controller?.destroy();
        this._controller = null;
    }
}
