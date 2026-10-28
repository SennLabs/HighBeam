// SPDX-License-Identifier: GPL-2.0-or-later

export default [
    {
        ignores: ['build/**', 'node_modules/**'],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                global: 'readonly',
                console: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            'no-undef': 'error',
            'prefer-const': 'error',
            'eqeqeq': 'error',
            'no-eval': 'error',
            'indent': ['error', 4, {SwitchCase: 0}],
            'quotes': ['error', 'single', {avoidEscape: true}],
            'semi': ['error', 'always'],
            'comma-dangle': ['error', 'always-multiline'],
        },
    },
];
