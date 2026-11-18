// ceSourceFromDom must read the editor DOM IN ORDER and take bare text
// nodes literally: after select-all + type the browser replaces the
// token spans with one plain text node, and the old spans-only read
// returned '' — the typed text was dropped and an empty source
// committed (the select-all e2e failed on exactly that).
import {describe, expect, it} from 'vitest';
import {loadApp} from './helpers/load-app.js';

const w = loadApp();
const doc = w.document;

function span(kind, src, text) {
  const sp = doc.createElement('span');
  sp.dataset.s0 = '0';
  sp.dataset.s1 = String(src.length);
  sp.dataset.src = src;
  sp.dataset.kind = kind;
  sp.textContent = text;
  return sp;
}

describe('ceSourceFromDom', () => {
  it('a bare text node (select-all + type) is the source, not ""', () => {
    const ec = doc.createElement('div');
    ec.append(doc.createTextNode('Chapter one, replaced by select-all.'));
    expect(w.ceSourceFromDom({ec}))
      .toBe('Chapter one, replaced by select-all.');
  });

  it('text nodes and spans keep their document order', () => {
    const ec = doc.createElement('div');
    ec.append(doc.createTextNode('before '));
    ec.append(span('plain', 'run', w.srcToText('run')));
    ec.append(doc.createTextNode(' after'));
    expect(w.ceSourceFromDom({ec})).toBe('before run after');
  });

  it('atomic spans contribute their source slice, not their text', () => {
    const ec = doc.createElement('div');
    ec.append(span('atomic', '\\texttt{x}', 'x'));
    expect(w.ceSourceFromDom({ec})).toBe('\\texttt{x}');
  });

  it('unedited plain spans map back to their source slice', () => {
    const ec = doc.createElement('div');
    ec.append(span('plain', 'a~b\nc', w.srcToText('a~b\nc')));
    expect(w.ceSourceFromDom({ec})).toBe('a~b\nc');
  });

  it('an edited plain span contributes its live text', () => {
    const ec = doc.createElement('div');
    ec.append(span('plain', 'original', 'rewritten by hand'));
    expect(w.ceSourceFromDom({ec})).toBe('rewritten by hand');
  });

  it('a raw fragment contributes its literal source text', () => {
    const ec = doc.createElement('div');
    ec.append(span('raw', '\\emph{word}', '\\emph{word}'));
    expect(w.ceSourceFromDom({ec})).toBe('\\emph{word}');
  });
});
