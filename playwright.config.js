import {defineConfig} from '@playwright/test';

// E2E smoke: each spec file spawns the real server (tests/e2e/helpers/
// server.js) against a throwaway copy of demo/. One worker: the tests
// share a single server + project and run in file order.
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  // one retry: the app's editor/render state machine has known client-
  // side races (TESTING.md register #13/#14) that surface here
  // intermittently; the smoke suite fails fast and retries once rather
  // than brute-forcing them
  retries: 1,
  timeout: 60_000,
  expect: {timeout: 10_000},
  reporter: [['list']],
});
