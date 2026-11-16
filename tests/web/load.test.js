// M0 harness smoke test (TESTING.md): proves the real app.js evaluates
// cleanly in jsdom against the real index.html shell, boot completes
// without errors, and the pure functions the M4 suites target are
// reachable as window globals.
import {describe, expect, it} from 'vitest';
import {loadApp} from './helpers/load-app.js';

describe('app.js loads in the jsdom harness', () => {
  it('boots without init errors', () => {
    const window = loadApp();
    expect(window.__initError).toBeUndefined();
    expect(window.document.getElementById('projlist')).not.toBeNull();
  });

  it('exposes the pure functions the M4 suites target', () => {
    const window = loadApp();
    const names = [
      'renderInline', 'readGroups', 'readGroup', 'findUnescaped',
      'tokenizeTableBody', 'tableBodyToModel', 'serializeTableRich',
      'parseTabular', 'parseTabularLenient',
      'figureParts', 'listItems', 'srcToText',
      'shiftGit', 'gitMarksFor', 'shiftMarks',
      'acContext', 'acSuggestions', 'mergeIssues', 'diffKeys',
      'renderUnit', 'siUnitToMath', 'groupDigits',
      'computeSectionChanges', 'outlineMoveParams',
    ];
    for (const name of names) {
      expect(typeof window[name], `window.${name}`).toBe('function');
    }
  });

  it('exposes the app state object', () => {
    const window = loadApp();
    // `state` is a top-level const: a global lexical binding, not a
    // window property — read it through the realm's eval
    const state = window.eval('state');
    expect(state).toBeTypeOf('object');
    expect(state).toHaveProperty('doc');
    expect(state).toHaveProperty('projects');
  });
});
