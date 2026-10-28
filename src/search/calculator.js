// SPDX-License-Identifier: GPL-2.0-or-later
//
// A small arithmetic expression evaluator for the calculator results. It is a
// hand-written recursive-descent parser (extensions may not use eval). Pure
// JavaScript with no GNOME imports, so it can be unit-tested with `gjs -m`.
//
// Grammar, loosest binding first:
//   expr    = term (('+' | '-') term)*
//   term    = unary (('*' | '/' | '%') unary | <implicit *> unary)*
//   unary   = ('-' | '+') unary | power
//   power   = postfix ('^' unary)?          right-associative, so -2^2 = -4
//   postfix = primary '!'*
//   primary = number | constant | function unary | '(' expr ')'

const CONSTANTS = {
    pi: Math.PI,
    'π': Math.PI,
    tau: 2 * Math.PI,
    e: Math.E,
};

const FUNCTIONS = {
    sqrt: Math.sqrt,
    '√': Math.sqrt,
    cbrt: Math.cbrt,
    abs: Math.abs,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    ln: Math.log,
    log: Math.log10,
    log2: Math.log2,
    exp: Math.exp,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
};

// Typographic operators people paste or type, mapped to ASCII.
const OPERATOR_ALIASES = {
    '×': '*',
    '·': '*',
    '÷': '/',
    '−': '-',
    '**': '^',
};

const MAX_FACTORIAL = 170; // 171! overflows a double
// Longer input, or deeper nesting, isn't a calculation anyone types; refuse
// it rather than recurse until the stack runs out.
const MAX_LENGTH = 1000;
const MAX_DEPTH = 100;

class ParseError extends Error {}

function tokenize(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const rest = text.slice(i);
        let m;
        if ((m = /^\s+/.exec(rest))) {
            // skip
        } else if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) {
            const after = rest.slice(m[0].length);
            // "1.2.3" and "192.168.1.1" are versions and addresses, "0x1f" is
            // hex, and "1e" is an exponent still being typed: none are sums.
            if (/^\.\d/.test(after) || /^[eE](?![a-zA-Z])/.test(after) ||
                (m[0] === '0' && /^x[0-9a-fA-F]/.test(after)))
                throw new ParseError('not a number');
            tokens.push({type: 'num', value: parseFloat(m[0])});
        } else if ((m = /^\*\*/.exec(rest))) {
            tokens.push({type: 'op', value: '^'});
        } else if ((m = /^[a-zA-Z_][a-zA-Z0-9_]*|^[π√]/.exec(rest))) {
            const name = m[0].toLowerCase();
            // "2 x 3" and "2x3" mean multiply.
            if (name === 'x' || /^x\d/.test(name)) {
                tokens.push({type: 'op', value: '*'});
                i += 1;
                continue;
            }
            tokens.push({type: 'ident', value: name});
        } else if ((m = /^[-+*/%^!()×·÷−]/.exec(rest))) {
            tokens.push({type: 'op', value: OPERATOR_ALIASES[m[0]] ?? m[0]});
        } else {
            throw new ParseError(`unexpected character ${rest[0]}`);
        }
        i += m[0].length;
    }
    return tokens;
}

function factorial(n) {
    if (!Number.isInteger(n) || n < 0 || n > MAX_FACTORIAL)
        return NaN;
    let result = 1;
    for (let k = 2; k <= n; k++)
        result *= k;
    return result;
}

class Parser {
    constructor(tokens) {
        this._tokens = tokens;
        this._pos = 0;
        this._depth = 0;
        // Set once the input does more than state a single number, so plain
        // "42", "-5" or "pi" don't show a calculator result.
        this.didWork = false;
    }

    parse() {
        const value = this._expr();
        if (this._pos < this._tokens.length)
            throw new ParseError('trailing input');
        return value;
    }

    _peek() {
        return this._tokens[this._pos];
    }

    _isOp(value) {
        const token = this._peek();
        return token?.type === 'op' && token.value === value;
    }

    _next() {
        const token = this._tokens[this._pos++];
        if (!token)
            throw new ParseError('unexpected end');
        return token;
    }

    _expr() {
        let value = this._term();
        while (this._isOp('+') || this._isOp('-')) {
            const op = this._next().value;
            const right = this._term();
            value = op === '+' ? value + right : value - right;
            this.didWork = true;
        }
        return value;
    }

    _startsPrimary() {
        const token = this._peek();
        return token?.type === 'num' || token?.type === 'ident' ||
            (token?.type === 'op' && token.value === '(');
    }

    _term() {
        let value = this._unary();
        for (;;) {
            if (this._isOp('*') || this._isOp('/') || this._isOp('%')) {
                const op = this._next().value;
                const right = this._unary();
                if (op === '*')
                    value *= right;
                else if (op === '/')
                    value /= right;
                else
                    value %= right;
            } else if (this._startsPrimary() && this._peek().type !== 'num') {
                // Implicit multiplication: "2pi", "3(4+1)". Never between two
                // numbers: "0412 345 678" is a phone number, not a product.
                value *= this._unary();
            } else {
                return value;
            }
            this.didWork = true;
        }
    }

    _unary() {
        if (++this._depth > MAX_DEPTH)
            throw new ParseError('too deep');
        try {
            if (this._isOp('-')) {
                this._next();
                return -this._unary();
            }
            if (this._isOp('+')) {
                this._next();
                return this._unary();
            }
            return this._power();
        } finally {
            this._depth--;
        }
    }

    _power() {
        const base = this._postfix();
        if (!this._isOp('^'))
            return base;
        this._next();
        this.didWork = true;
        return base ** this._unary();
    }

    _postfix() {
        let value = this._primary();
        while (this._isOp('!')) {
            this._next();
            value = factorial(value);
            this.didWork = true;
        }
        return value;
    }

    _primary() {
        const token = this._next();
        if (token.type === 'num')
            return token.value;

        if (token.type === 'op' && token.value === '(') {
            const value = this._expr();
            if (!this._isOp(')'))
                throw new ParseError('missing )');
            this._next();
            return value;
        }

        if (token.type === 'ident') {
            if (Object.hasOwn(FUNCTIONS, token.value)) {
                this.didWork = true;
                // "sin(x)^2" squares the sine; only the bracketed argument
                // belongs to the function. Without brackets the argument is
                // the next unary: "sqrt 16 + 1" = 5.
                const fn = FUNCTIONS[token.value];
                return fn(this._isOp('(') ? this._primary() : this._unary());
            }
            if (Object.hasOwn(CONSTANTS, token.value))
                return CONSTANTS[token.value];
        }

        throw new ParseError(`unexpected ${token.value}`);
    }
}

/**
 * Format a result for display and copying: integers exactly while a double can
 * hold them, other numbers rounded to 12 significant digits so 0.1+0.2 shows
 * as 0.3. Big numbers use exponent form, so a rounded value never looks exact.
 *
 * @param {number} value
 * @returns {string}
 */
export function formatNumber(value) {
    if (Object.is(value, -0))
        return '0';
    if (Number.isSafeInteger(value))
        return String(value);
    if (Math.abs(value) >= 1e15)
        return value.toExponential(11).replace(/\.?0+e/, 'e');
    return String(parseFloat(value.toPrecision(12)));
}

/**
 * Evaluate `text` as arithmetic.
 *
 * @param {string} text the query
 * @returns {number|null} the value, or null if `text` isn't a calculation
 *   (not an expression, only a single number, or no finite answer)
 */
export function evaluate(text) {
    if (text.length > MAX_LENGTH)
        return null;
    let tokens;
    try {
        tokens = tokenize(text);
    } catch {
        return null;
    }
    if (tokens.length === 0)
        return null;

    const parser = new Parser(tokens);
    let value;
    try {
        value = parser.parse();
    } catch (e) {
        if (e instanceof ParseError)
            return null;
        throw e;
    }
    if (!parser.didWork || !Number.isFinite(value))
        return null;
    return value;
}
