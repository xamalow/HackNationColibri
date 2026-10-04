import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.test-dist/**', '**/.venv/**', '**/.expo/**', '**/ios/**', '**/android/**', '.sentinelayer/**', 'apps/hub-voice/demo/vendor/**'] },
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly', TextEncoder: 'readonly' },
    },
  },
  {
    files: ['**/*.config.js', '**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { __dirname: 'readonly', __filename: 'readonly' } },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] },
  },
  {
    files: ['**/tests/**/*.ts'],
    // In-memory transaction test doubles capture their owning store in callbacks.
    rules: { '@typescript-eslint/no-this-alias': 'off' },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    // Explicit Node-only evaluation entrypoint; it is not exported by the portable core.
    ignores: ['packages/core/src/tools/w3-adapter.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['node:*'], paths: ['fs', 'crypto', 'http', 'https'] }],
      'no-restricted-globals': ['error', 'fetch', 'WebSocket', 'XMLHttpRequest'],
      'no-restricted-properties': ['error', { object: 'Date', property: 'now', message: 'The host supplies authority time.' }],
    },
  },
);
