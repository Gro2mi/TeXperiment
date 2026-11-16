// M4 — remaining pure helpers: figures, lists, comments, raw-column
// text mapping, diff-mark shifting, autocomplete contexts/suggestions
import {describe, expect, it, beforeAll} from 'vitest';
import {loadApp} from './helpers/load-app.js';

const w = loadApp();

describe('figureParts', () => {
  it('extracts path, optional argument and nested caption', () => {
    const p = w.figureParts(
      '\\begin{figure}\n' +
      '  \\includegraphics[width=0.5\\textwidth]{fig/plot.png}\n' +
      '  \\caption{A {nested} caption.}\n' +
      '\\end{figure}');
    expect(p.path).toBe('fig/plot.png');
    expect(p.caption).toBe('A {nested} caption.');
  });

  it('no graphics means null path, empty caption', () => {
    expect(w.figureParts('\\begin{figure}\\end{figure}'))
      .toEqual({path: null, caption: ''});
  });
});

describe('listItems', () => {
  it('splits top-level items', () => {
    const items = w.listItems(
      '\\begin{itemize}\n\\item a\n\\item b\n\\end{itemize}');
    expect(items.map(x => x.trim())).toEqual(['a', 'b']);
  });

  it('keeps nested environments inside their outer item', () => {
    const items = w.listItems(
      '\\begin{enumerate}\n\\item a\n\\begin{itemize}\n\\item n\n' +
      '\\end{itemize}\n\\item b\n\\end{enumerate}');
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('\\begin{itemize}');
    expect(items[0]).toContain('\\item n');
    expect(items[1].trim()).toBe('b');
  });

  it('text before the first \\item becomes an implicit item (pinned)', () => {
    const items = w.listItems('\\begin{itemize}\nintro\n\\item a\n\\end{itemize}');
    expect(items.map(x => x.trim())).toEqual(['intro', 'a']);
  });
});

describe('stripCommentDecorations', () => {
  it('drops decoration-only lines, keeps text lines', () => {
    expect(w.stripCommentDecorations('% ------\n% text here\n'))
      .toBe('% text here');
  });

  it('strips decoration runs and collapses the leftover spaces', () => {
    expect(w.stripCommentDecorations('% see === this ===\n'))
      .toBe('% see this');
  });
});

describe('srcToText (raw-column DOM text mapping)', () => {
  it('escapes entities, maps newlines and ties to spaces', () => {
    expect(w.srcToText('a\nb~c<d>&e')).toBe('a b c&lt;d&gt;&amp;e');
  });
});

describe('shiftGit / shiftMarks (diff-mark coordinates)', () => {
  it('clips add ranges into the sub-window, drops out-of-window dels', () => {
    const g = w.shiftGit({adds: [{s: 2, e: 8}, {s: 20, e: 25}],
                          dels: [{s: 3, text: 'x'}, {s: 6, text: 'y'}]},
                         4, 10);
    expect(g.adds).toEqual([{s: 0, e: 4}]);       // second add is outside
    expect(g.dels).toEqual([{s: 2, text: 'y'}]);  // s=3 before the window
  });

  it('returns null when nothing overlaps the window', () => {
    expect(w.shiftGit({adds: [{s: 50, e: 60}], dels: []}, 0, 10)).toBeNull();
  });

  it('shiftMarks clips [s,e] pairs', () => {
    expect(w.shiftMarks([[0, 5], [8, 12], [30, 40]], 4, 10))
      .toEqual([[0, 1], [4, 8]]);
    expect(w.shiftMarks([], 0, 10)).toEqual([]);
  });
});

describe('prefixContext / acContext (autocomplete detection)', () => {
  it('detects cite, ref and graphic brace contexts', () => {
    expect(w.prefixContext('as \\citep{eu')).toEqual({kind: 'cite', typed: 'eu'});
    expect(w.prefixContext('see \\ref{eq:')).toEqual({kind: 'ref', typed: 'eq:'});
    expect(w.prefixContext('\\includegraphics[width=1\\textwidth]{fig'))
      .toEqual({kind: 'graphic', typed: 'fig'});
  });

  it('takes the last key after a comma in multi-key cites', () => {
    expect(w.prefixContext('\\cite{a, b')).toEqual({kind: 'cite', typed: 'b'});
  });

  it('detects a partial command after a backslash', () => {
    expect(w.prefixContext('text \\subsec')).toEqual({kind: 'cmd', typed: 'subsec'});
  });

  it('an escaped backslash is not a command start', () => {
    expect(w.prefixContext('line \\\\')).toBeNull();
  });

  it('no context in plain text', () => {
    expect(w.prefixContext('just words')).toBeNull();
  });

  it('acContext flags the unit position of \\SI', () => {
    // textarea is jsdom-native; set value + selection via the DOM
    const ta = w.document.createElement('textarea');
    ta.value = 'a \\SI{5}{ki';
    w.document.body.append(ta);
    ta.focus();
    ta.setSelectionRange(11, 11);
    expect(w.acContext(ta)).toEqual({kind: 'unit', typed: 'ki'});
    ta.remove();
  });
});

describe('acSuggestions', () => {
  it('filters commands by prefix, capped at 12', () => {
    const all = w.acSuggestions('cmd', '');
    expect(all).toHaveLength(12);
    expect(all[0].insert).toBe('\\section{|}');
    const cites = w.acSuggestions('cmd', 'citey');
    expect(cites.map(c => c.title)).toEqual(['\\citeyear']);
  });

  it('units match on unit text or description', () => {
    expect(w.acSuggestions('unit', 'm/s')[0].insert).toBe('m/s');
    expect(w.acSuggestions('unit', 'metre').map(s => s.insert))
      .toContain('m');   // matched via "metre — length"
    // regression: '\Omega' in the table source collapsed to 'Omega' in
    // JS (unknown escape), inserting the unit without its backslash
    // (reached via its description: the unit text starts with a backslash)
    expect(w.acSuggestions('unit', 'ohm').map(s => s.insert))
      .toEqual(['\\Omega']);
  });

  it('cite suggestions come from the bibliography when available', () => {
    w.eval('state.bib = ' + JSON.stringify({
      available: true, style: 'numeric',
      entries: [{key: 'euler1748', authors: 'Euler', year: '1748'},
                {key: 'knuth1984', authors: 'Knuth', year: '1984'}]}));
    const items = w.acSuggestions('cite', 'eu');
    expect(items.map(i => i.insert)).toEqual(['euler1748']);
  });

  it('graphic suggestions list filenames with their folders', () => {
    w.eval('state.graphics = ' + JSON.stringify(
      ['figures/plot.png', 'logo.svg']));
    const items = w.acSuggestions('graphic', '');
    expect(items[0]).toEqual({insert: 'figures/plot.png', title: 'plot.png',
                              sub: 'figures'});
    // root-level files say "project root" — this was the register #9 bug:
    // slice(0, -1) chopped the last character into "logo.sv"
    expect(items[1].sub).toBe('project root');
  });
});

describe('mergeIssues', () => {
  beforeAll(() => {
    w.eval('state.doc = ' + JSON.stringify(
      {blocks: [{id: 'b1'}, {id: 'b2'}, {id: 'b3'}]}));
  });

  it('sorts by block order, then by start offset', () => {
    const merged = w.mergeIssues(
      [{block_id: 'b2', start: 1}, {block_id: 'b1', start: 5}],
      [{block_id: 'b1', start: 0}, {block_id: 'zzz', start: 0}]);
    expect(merged.map(i => [i.block_id, i.start])).toEqual(
      [['b1', 0], ['b1', 5], ['b2', 1], ['zzz', 0]]);  // unknown last
  });
});
