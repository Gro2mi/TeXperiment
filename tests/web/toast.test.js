// sticky error toasts: an error relayed from the server (callers pass
// the caught Error object) is red, grows an ✕, and never auto-hides —
// only clicking the ✕ dismisses it. Client-side hints (plain `true`)
// keep the red styling and the 3.5 s auto-fade. The timings here are
// real-time (app.js schedules through jsdom's window timers), so the
// fades assert after the 3.5 s window with an explicit test timeout.
import {describe, expect, it} from 'vitest';
import {loadApp} from './helpers/load-app.js';

const w = loadApp();
const toastEl = () => w.document.getElementById('toast');
const shown = () => !toastEl().classList.contains('hidden');

describe('toast dismissal', () => {
  it('server error object: red, ✕ button, survives the fade window, ✕ dismisses',
    {timeout: 15000}, async () => {
      w.toast('Could not write the file — it is locked by another program.',
        Object.assign(new Error('locked'), {status: 503}));
      expect(shown()).toBe(true);
      expect(toastEl().classList.contains('err')).toBe(true);
      const x = toastEl().querySelector('.toast-x');
      expect(x, 'server error toasts carry the ✕').toBeTruthy();
      // well past the 3.5 s auto-fade: still visible
      await new Promise(r => setTimeout(r, 3700));
      expect(shown()).toBe(true);
      // the ONLY way it goes away
      x.click();
      expect(shown()).toBe(false);
    });

  it('client-side hint (plain true): red, no ✕, auto-fades', {timeout: 15000},
    async () => {
      w.toast('Enter a commit message first', true);
      expect(shown()).toBe(true);
      expect(toastEl().classList.contains('err')).toBe(true);
      expect(toastEl().querySelector('.toast-x')).toBeNull();
      await new Promise(r => setTimeout(r, 3700));
      expect(shown(), 'hint toasts fade on their own').toBe(false);
    });

  it('success toast: no ✕, auto-fades', {timeout: 15000}, async () => {
    w.toast('Saved');
    expect(shown()).toBe(true);
    expect(toastEl().classList.contains('err')).toBe(false);
    expect(toastEl().querySelector('.toast-x')).toBeNull();
    await new Promise(r => setTimeout(r, 3700));
    expect(shown()).toBe(false);
  });

  it('a later hint does not inherit the previous error\u2019s ✕', () => {
    w.toast('server boom', new Error('boom'));
    expect(toastEl().querySelector('.toast-x')).toBeTruthy();
    w.toast('hint', true);
    expect(toastEl().querySelector('.toast-x')).toBeNull();
    expect(toastEl().textContent).toBe('hint');
  });
});
