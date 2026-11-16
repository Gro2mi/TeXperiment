import js from '@eslint/js';
import globals from 'globals';

// Minimal baseline for the no-build frontend. web/app.js is a classic
// script running in a browser with two CDN globals (katex, MathLive's
// mathVirtualKeyboard); the tests are ESM under vitest.
export default [
  {
    files: ['web/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        katex: 'readonly',
        mathVirtualKeyboard: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // ~250 top-level functions are wired through HTML handlers and the
      // boot IIFE; eslint's unused-args noise outweighs value here
      'no-unused-vars': ['error', {
        args: 'none', caughtErrors: 'none',
        varsIgnorePattern: '^_',
      }],
      // deliberate swallow-quietly catches are idiomatic in the UI layer
      // (blur handlers, best-effort localStorage); empty try bodies are
      // still errors
      'no-empty': ['error', {allowEmptyCatch: true}],
    },
  },
  {
    files: ['tests/**/*.js', 'vitest.config.js', 'eslint.config.js',
            'playwright.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {...globals.browser, ...globals.node},
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', {
        args: 'none', caughtErrors: 'none',
        varsIgnorePattern: '^_',
      }],
    },
  },
];
