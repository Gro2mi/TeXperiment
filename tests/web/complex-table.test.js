// Complex tables: the expose verification-errors table (S columns with
// options, multicolumn headers, paired \cmidrule ranges, braced cells)
// must parse, render with spans + partial rules, and round-trip.
import {describe, expect, it} from 'vitest';
import {loadApp} from './helpers/load-app.js';

const w = loadApp();
const state = w.eval('state');

const TABLE = [
  '\\begin{table}[htbp]',
  '  \\centering',
  '  \\small',
  '  \\begin{tabular}{S[table-format=2.0]',
  '                  S[table-format=1.3] S[table-format=1.3]',
  '                  S[table-format=1.3] S[table-format=1.3]',
  '                  S[table-format=1.3] S[table-format=1.3]',
  '                  S[table-format=1.3] S[table-format=1.3]}',
  '    \\toprule',
  '    & \\multicolumn{4}{c}{\\textbf{Similarity solution}}',
  '    & \\multicolumn{4}{c}{\\textbf{Dam break}} \\\\',
  '    \\cmidrule(lr){2-5} \\cmidrule(lr){6-9}',
  '    & \\multicolumn{2}{c}{$h$} & \\multicolumn{2}{c}{$h\\mathbf{u}$}',
  '    & \\multicolumn{2}{c}{$h$} & \\multicolumn{2}{c}{$h \\lVert \\mathbf{u} \\rVert$} \\\\',
  '    \\cmidrule(lr){2-3} \\cmidrule(lr){4-5} \\cmidrule(lr){6-7} \\cmidrule(lr){8-9}',
  '    {$t$ (s)} & {$L_2$} & {$L_{\\max}$} & {$L_2$} & {$L_{\\max}$}',
  '      & {$L_2$} & {$L_{\\max}$} & {$L_2$} & {$L_{\\max}$} \\\\',
  '    \\midrule',
  '     5 & 0.012 & 0.023 & 0.013 & 0.034 & 0.023 & 0.053 & 0.057 & 0.151 \\\\',
  '    \\bottomrule',
  '  \\end{tabular}',
  '  \\caption{Relative errors.}',
  '  \\label{tab:verification-errors}',
  '\\end{table}',
].join('\n');

const BLOCK = {id: 'tb1', type: 'table', file: 'main.tex', source: TABLE};
const M = w.parseTableRich(TABLE);

describe('complex table: parse', () => {
  it('parses the S[...] colspec with braces verbatim', () => {
    expect(M).not.toBeNull();
    expect(M.colspec).toContain('S[table-format=2.0]');
    expect(M.colspec.replace(/\s+/g, '')).toBe(
      'S[table-format=2.0]' + 'S[table-format=1.3]'.repeat(8));
  });
  it('collects all rules: toprule, 6 cmidrules, midrule, bottomrule', () => {
    expect(M.rules.map(r => r.kind)).toEqual([
      'toprule', 'cmidrule', 'cmidrule',
      'cmidrule', 'cmidrule', 'cmidrule', 'cmidrule',
      'midrule', 'bottomrule',
    ]);
    // two cmidrules share the boundary before row 1, four share row 2's
    expect(M.rules.filter(r => r.before === 1).length).toBe(2);
    expect(M.rules.filter(r => r.before === 2).length).toBe(4);
  });
  it('multicolumn header cells keep their spans and inner text', () => {
    expect(M.rows[0].cells[0].mc).toBeNull();       // leading empty cell
    expect(M.rows[0].cells[1].mc).toEqual({n: 4, spec: 'c'});
    expect(M.rows[0].cells[1].text).toBe('\\textbf{Similarity solution}');
  });
  it('braced cells keep their braces for round-tripping', () => {
    expect(M.rows[2].cells[0].text).toBe('{$t$ (s)}');
  });
});

describe('complex table: render', () => {
  it('renders colspan for the multicolumn headers', () => {
    const html = w.renderRichTableHTML(M, BLOCK);
    expect(html).toContain('colspan="4"');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('Similarity solution');
  });
  it('renders partial cmidrule ranges at their columns', () => {
    const html = w.renderRichTableHTML(M, BLOCK);
    expect((html.match(/rcmidrule/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('triml');   // (lr) specs → trim classes
    expect(html).toContain('trimr');
    // the {2-5} span: a colspan=4 segment after a 1-column gap
    expect(html).toContain('colspan="1" class="rrulegap"');
    expect(html).toContain('colspan="4" class="rcmidrule');
  });
  it('full rules span the whole table', () => {
    const html = w.renderRichTableHTML(M, BLOCK);
    expect(html).toContain('rr-toprule');
    expect(html).toContain('rr-midrule');
    expect(html).toContain('rr-bottomrule');
  });
  it('blockContent renders caption + label chip, no stray braces in cells', () => {
    state.doc = {blocks: [BLOCK]};
    const html = w.renderBlockContent(BLOCK);
    expect(html).toContain('Relative errors.');
    expect(html).toContain('data-label="tab:verification-errors"');
    expect(html).not.toContain('{$t$');   // braces dropped in the render
    expect(html).toContain('katex-stub'); // $h$ etc. render as math
  });
});

describe('complex table: grid editor round-trip', () => {
  // rows may be RE-FLOWED to one line each (the model has no memory of
  // inter-cell newlines) — structure, cells, rules and meta must survive
  it('serialize(parse(src)) preserves rows, rules, caption and label', () => {
    const back = w.serializeTableRich(M);
    expect(back).toContain('\\begin{table}[htbp]');
    expect(back).toContain('\\begin{tabular}{S[table-format=2.0]');
    expect(back).toContain('\\cmidrule(lr){2-5} \\cmidrule(lr){6-9}');
    expect(back).toContain('\\cmidrule(lr){2-3} \\cmidrule(lr){4-5} ' +
      '\\cmidrule(lr){6-7} \\cmidrule(lr){8-9}');
    expect(back).toContain('\\textbf{Similarity solution}');
    expect(back).toContain('\\multicolumn{2}{c}{$h\\mathbf{u}$}');
    expect(back).toContain('{$t$ (s)}');
    expect(back).toContain('5 & 0.012 & 0.023 & 0.013 & 0.034');
    expect(back).toContain('\\caption{Relative errors.}');
    expect(back).toContain('\\label{tab:verification-errors}');
    expect(back).toContain('\\bottomrule');
    // one round-trip further: stable (idempotent)
    expect(w.serializeTableRich(w.parseTableRich(back))).toBe(back);
  });
});
