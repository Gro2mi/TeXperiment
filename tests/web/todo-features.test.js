// TODO.md round: bare-brace groups render without braces, \cmidrule(lr)
// ranges parse + round-trip, figure label chips exist
import {describe, expect, it} from 'vitest';
import {loadApp} from './helpers/load-app.js';

const w = loadApp();
const R = src => w.renderInline(src);

describe('bare brace groups are markup, not content', () => {
  it('{\\textbf{...}} renders bold without braces (table headers)', () => {
    expect(R('{\\textbf{Difference (m)}}')).toBe('<strong>Difference (m)</strong>');
  });

  it('a braced math cell {$L_2$} renders the math without braces', () => {
    expect(R('{$L_2$}')).toBe('<span class="katex-stub">L_2</span>');
  });

  it('plain brace groups keep their inner rendering, braces dropped', () => {
    expect(R('{hello}')).toBe('hello');
    expect(R('a {b\\textit{c} d} e')).toBe('a b<em>c</em> d e');
  });

  it('escaped braces stay literal', () => {
    expect(R('\\{x\\}')).toBe('{x}');
  });

  it('a stray closing brace stays visible', () => {
    expect(R('a } b')).toBe('a } b');
  });

  it('unclosed group renders the rest without a brace', () => {
    expect(R('{still typing')).toBe('still typing');
  });
});

describe('cmidrule trim specs parse as rule args', () => {
  const T = [
    '\\begin{tabular}{ll}',
    '\\toprule',
    'A & B \\\\',
    '\\midrule',
    'X & \\multicolumn{1}{c}{\\textbf{Y}} \\\\',
    '\\cmidrule(lr){1-1} \\cmidrule(lr){2-2}',
    'p & q \\\\',
    '\\bottomrule',
    '\\end{tabular}',
  ].join('\n');

  it('the (lr) spec stays in the rule arg, never in a cell', () => {
    const m = w.parseTableRich(T);
    expect(m).not.toBeNull();
    const cm = m.rules.filter(r => r.kind === 'cmidrule');
    expect(cm.length).toBe(2);
    expect(cm[0].arg).toBe('(lr){1-1}');
    expect(cm[1].arg).toBe('(lr){2-2}');
    // no cell text was polluted by the trim specs
    for (const row of m.rows)
      for (const c of row.cells)
        expect(c.text).not.toContain('(lr)');
  });

  it('serialization round-trips the cmidrule args', () => {
    const m = w.parseTableRich(T);
    const back = w.serializeTableRich(m);
    expect(back).toContain('\\cmidrule(lr){1-1}');
    expect(back).toContain('\\cmidrule(lr){2-2}');
    expect(back).toContain('\\multicolumn{1}{c}{\\textbf{Y}}');
  });
});

describe('figure label chip', () => {
  it('renders a refchip for the figure \\label', () => {
    const w2 = loadApp();
    const state = w2.eval('state');  // lexical binding, not a window prop
    state.doc = {blocks: [{
      id: 'f1', type: 'figure', file: 'main.tex',
      source: '\\begin{figure}\n\\includegraphics{plot}\n'
        + '\\caption{A plot.}\n\\label{fig:plot}\n\\end{figure}',
    }]};
    state.graphicCache.set('plot', null);
    const html = w2.renderBlockContent(state.doc.blocks[0]);
    expect(html).toContain('data-label="fig:plot"');
    expect(html).toContain('label:fig:plot');
  });
});
