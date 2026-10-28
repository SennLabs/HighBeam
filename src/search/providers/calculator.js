// SPDX-License-Identifier: GPL-2.0-or-later
//
// Answers arithmetic typed into the search box ("2+2", "sqrt(2)*pi"). Enter
// copies the answer to the clipboard.

import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {evaluate, formatNumber} from '../calculator.js';
import {Score} from '../ranking.js';

export class CalculatorProvider {
    constructor() {
        this.id = 'highbeam-calculator';
        this.name = _('Calculator');
        this.isRemote = false;
        this.canLaunchSearch = false;
        // A query that parses as a calculation is almost certainly one, so
        // the answer beats an app with the same exact score.
        this.bias = 0.1;
        // Its result ids don't mean the same thing next time, so don't learn from picks.
        this.recordHistory = false;
    }

    search(terms, _previousState, _cancellable) {
        const expression = terms.join(' ');
        const value = evaluate(expression);
        if (value === null)
            return Promise.resolve({state: null, results: []});

        const answer = formatNumber(value);
        return Promise.resolve({
            state: null,
            results: [{
                id: 'answer',
                name: answer,
                description: _('%s = %s · Enter copies the answer').format(expression, answer),
                createIcon: size => new St.Icon({icon_name: 'accessories-calculator-symbolic', icon_size: size}),
                score: Score.EXACT,
                answer,
            }],
        });
    }

    activate(result, _terms, _options) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, result.answer);
    }
}
