import {defineConfig} from 'vitest/config';

// Dev-only web tests. Each test builds its own jsdom window via
// tests/web/helpers/load-app.js (loads the real web/app.js), so the
// environment here stays 'node'.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/web/**/*.test.js'],
  },
});
