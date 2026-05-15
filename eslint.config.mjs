import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: ['dist/**', '.test/**', 'scratch/**', 'coverage/**'],
    },
    {
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-this-alias': 'off',
            '@typescript-eslint/no-misused-new': 'off',
            'no-console': 'off',
            'no-empty': 'off',
            'prefer-const': 'error',
            'no-useless-assignment': 'warn',
            'preserve-caught-error': 'off',
        },
    },
);