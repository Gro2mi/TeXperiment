// M4 — renderInline: the LaTeX → HTML engine behind every paragraph
import {describe, expect, it} from 'vitest';
import {loadApp} from './helpers/load-app.js';

const w = loadApp();
const R = src => w.renderInline(src);

describe('renderInline basics', () => {
  it('passes plain text through, escaped', () => {
    expect(R('hello world')).toBe('hello world');
    expect(R('a < b')).toBe('a &lt; b');
  });

  it('renders newlines and ties as spaces', () => {
    expect(R('a\nb~c')).toBe('a b c');
  });

  it('unescapes LaTeX escapes', () => {
    expect(R('50\\% off')).toBe('50% off');
    expect(R('A\\&B')).toBe('A&amp;B');   // unescaped & is html-escaped
    expect(R('x\\,y')).toBe('x y');       // thin space
    expect(R('x\\!y')).toBe('xy');        // negative space: nothing
  });

  it('wraps a bare ampersand in a chip', () => {
    expect(R('a & b')).toBe(
      'a <span class="chip">&amp;</span> b');
  });

  it('drops \\item markers (the space after survives)', () => {
    expect(R('\\item first')).toBe(' first');
  });
});

describe('renderInline formatting commands', () => {
  it('bold / italic / underline / code', () => {
    expect(R('\\textbf{x}')).toBe('<strong>x</strong>');
    expect(R('\\textit{x}')).toBe('<em>x</em>');
    expect(R('\\emph{x}')).toBe('<em>x</em>');
    expect(R('\\underline{x}')).toBe('<u>x</u>');
    expect(R('\\texttt{x}')).toBe('<code>x</code>');
  });

  it('nested formatting composes', () => {
    expect(R('\\textbf{a \\emph{b} c}')).toBe('<strong>a <em>b</em> c</strong>');
  });

  it('footnote becomes a superscript', () => {
    expect(R('x\\footnote{note}')).toBe(
      'x<sup class="fn" title="footnote">note</sup>');
  });

  it('run-in paragraph headings render as a bold lead-in', () => {
    expect(R('\\paragraph{Terrain.} body')).toBe(
      '<span class="runin"><strong>Terrain.</strong> </span> body');
  });
});

describe('renderInline references and citations', () => {
  it('label renders as a chip', () => {
    expect(R('\\label{eq:x}')).toBe('<span class="chip">label:eq:x</span>');
  });

  it('unresolved refs carry the ref-unresolved marker', () => {
    // no doc loaded in the harness → the label cannot resolve
    expect(R('see \\ref{eq:missing}')).toBe(
      'see <span class="refchip ref-unresolved" ' +
      'data-label="eq:missing">eq:missing</span>');
  });

  it('citations without a bibliography fall back to a raw chip', () => {
    expect(R('as \\citep{euler1748} shows')).toBe(
      'as <span class="citechip">citep{euler1748}</span> shows');
  });
});

describe('renderInline unknown commands', () => {
  it('becomes one chip including its arguments (line break at line start)',
    () => {
      expect(R('\\unknowncmd{x}')).toBe(
        '<br><span class="cmdchip">\\unknowncmd{x}</span>');
      expect(R('a \\unknowncmd{x}')).toBe(
        'a <span class="cmdchip">\\unknowncmd{x}</span>');
    });

  it('unclosed brace group stays one atomic token (still typing)', () => {
    expect(R('a \\citep{eu')).toBe(
      'a <span class="cmdchip">\\citep{eu</span>');
  });
});

describe('renderInline comments and math', () => {
  it('a comment runs to the end of the line', () => {
    expect(R('text % note\nmore')).toBe(
      'text <span class="icomment">% note</span> more');
  });

  it('inline math goes through katex (stubbed in the harness)', () => {
    expect(R('$x^2$')).toBe('<span class="katex-stub">x^2</span>');
  });

  it('siunitx inside math is expanded before katex sees it', () => {
    const out = R('$\\SI{2}{\\metre}$');
    expect(out).toContain('\\mathrm{m}');
  });
});

describe('renderInline proof and git marks', () => {
  it('wraps a proof-marked run in a squiggle span', () => {
    expect(w.renderInline('abc def', [[0, 3]])).toBe(
      '<span class="pf-err">abc</span> def');
  });

  it('renders a green add-run and the red deletion placeholder', () => {
    const out = w.renderInline('new words here', null, {
      adds: [{s: 0, e: 3}], dels: [{s: 3, text: 'old '}]});
    // the del text is whitespace-collapsed for display and data-full
    expect(out).toBe('<span class="git-add">new</span>' +
      '<span class="git-del" data-full="old">old</span> words here');
  });
});

describe('brace group readers', () => {
  it('readGroup reads balanced groups with offsets', () => {
    const g = w.readGroup('  {a{b}c} rest', 0);
    expect(g.body).toBe('a{b}c');
    expect(g.end).toBe(9);
  });

  it('readGroup returns null without a brace', () => {
    expect(w.readGroup('  nope', 0)).toBeNull();
  });

  it('readGroups skips horizontal whitespace between groups', () => {
    const r = w.readGroups('{a} {b}', 0, 2);
    expect(r.groups).toEqual(['a', 'b']);
    expect(r.end).toBe(7);
  });

  it('findUnescaped skips escaped characters', () => {
    expect(w.findUnescaped('a\\}b}c', 0, '}')).toBe(4);
    expect(w.findUnescaped('a\\}b', 0, '}')).toBe(-1);
  });

  it('groupEndAt finds the end of a balanced group', () => {
    expect(w.groupEndAt('x{a{b}}y', 1)).toBe(7);
    expect(w.groupEndAt('x{a{b', 1)).toBe(-1);
  });
});
