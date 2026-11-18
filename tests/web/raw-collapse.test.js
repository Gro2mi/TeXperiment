// raw side blank-line collapse: the segment displays a shortened copy,
// keeps the real source for saves, expands on mousedown, collapses back
// on blur while the file is clean
import {describe, expect, it} from 'vitest';
import {loadApp} from './helpers/load-app.js';

const w = loadApp();
// jsdom lacks the CSS namespace and (in the node scope) event constructors
if (!w.CSS) w.CSS = {escape: s => s};
const ME = w.MouseEvent, FE = w.FocusEvent;
const state = w.eval('state');
const BS = String.fromCharCode(92);

function makeSeg(source) {
  state.doc = {blocks: [{id: 'b1', type: 'paragraph', file: 'm.tex',
    source}]};
  return w.rawSeg(state.doc.blocks[0], true, true);
}

const SRC = 'Before.' + BS + 'par' + '\n\n\n\n\n' + 'After the gap.' + BS + 'par';

describe('raw segment blank-line collapse', () => {
  it('displays collapsed runs (one blank line kept), keeps _realSrc', () => {
    const seg = makeSeg(SRC);
    expect(seg.textContent).toBe(
      'Before.' + BS + 'par' + '\n\n' + 'After the gap.' + BS + 'par');
    expect(seg._realSrc).toBe(SRC);
    expect(seg._expanded).toBe(false);
  });

  it('mousedown expands to the real source', () => {
    const seg = makeSeg(SRC);
    const r = seg.getBoundingClientRect();
    seg.dispatchEvent(new ME('mousedown',
      {bubbles: true, clientX: r.left + 10, clientY: r.top + 5}));
    expect(seg.textContent).toBe(SRC);
    expect(seg._expanded).toBe(true);
  });

  it('blur collapses back while the file is clean', () => {
    const seg = makeSeg(SRC);
    seg.dispatchEvent(new ME('mousedown',
      {bubbles: true, clientX: r0().x, clientY: r0().y}));
    function r0() { return {x: 10, y: 10}; }
    seg.dispatchEvent(new FE('blur'));
    expect(seg.textContent).toBe(
      'Before.' + BS + 'par' + '\n\n' + 'After the gap.' + BS + 'par');
    expect(seg._expanded).toBe(false);
  });

  it('rawFileText prefers _realSrc for collapsed segments', () => {
    state.doc = {blocks: [
      {id: 'b1', type: 'paragraph', file: 'm.tex', source: SRC},
      {id: 'b2', type: 'comment', file: 'm.tex', source: '% end'},
    ]};
    const seg = w.rawSeg(state.doc.blocks[0], true, false);
    const seg2 = w.rawSeg(state.doc.blocks[1], false, true);
    w.document.body.append(seg, seg2);   // segsOfFile queries the DOM
    // collapsed seg + a second seg (no blank runs: display == real)
    const texts = w.rawFileText('m.tex');
    expect(texts).toBe(SRC + '% end');
    seg.remove();
    seg2.remove();
  });
});
