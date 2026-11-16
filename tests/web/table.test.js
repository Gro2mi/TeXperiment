// M4 — table model: tokenize → model → serialize round-trips
// (tests/web/helpers/load-app.js loads the real app.js; top-level
// functions are window properties)
import {describe, expect, it} from 'vitest';
import {loadApp} from './helpers/load-app.js';

const w = loadApp();

describe('tokenizeTableBody', () => {
  it('splits cells, separators and row ends', () => {
    const toks = w.tokenizeTableBody('a & b \\\\ c & d');
    expect(toks.map(t => t.t)).toEqual(
      ['cell', 'sep', 'cell', 'rowend', 'cell', 'sep', 'cell']);
    // cells keep their surrounding whitespace; the model trims later
    expect(toks[0].text).toBe('a ');
    expect(toks[2].text).toBe(' b ');
    expect(toks[3].spacing).toBe('');
  });

  it('captures \\\\[1ex] spacing without leaking it into cells', () => {
    const toks = w.tokenizeTableBody('a \\\\[1ex] b');
    const rowend = toks.find(t => t.t === 'rowend');
    expect(rowend.spacing).toBe('[1ex]');
    expect(toks.map(t => t.t)).toEqual(['cell', 'rowend', 'cell']);
  });

  it('keeps escaped ampersands inside their cell', () => {
    const toks = w.tokenizeTableBody('a\\&b & c');
    expect(toks[0].t).toBe('cell');
    expect(toks[0].text).toBe('a\\&b ');
    expect(toks.filter(t => t.t === 'sep')).toHaveLength(1);
  });

  it('emits rule tokens with kind and argument', () => {
    const toks = w.tokenizeTableBody('\\toprule\n\\cline{2-3}\n');
    const rules = toks.filter(t => t.t === 'rule');
    expect(rules.map(r => r.kind)).toEqual(['toprule', 'cline']);
    expect(rules[1].arg).toBe('{2-3}');
  });
});

describe('tableBodyToModel', () => {
  it('builds rows and places rules on boundaries', () => {
    const m = w.tableBodyToModel(
      '\\toprule\nA & B \\\\\n\\midrule\nC & D \\\\\n\\bottomrule\n');
    expect(m.rows).toHaveLength(2);
    expect(m.rows[0].cells.map(c => c.text)).toEqual(['A', 'B']);
    expect(m.rules.map(r => [r.before, r.kind])).toEqual(
      [[0, 'toprule'], [1, 'midrule'], [2, 'bottomrule']]);
    expect(m.advanced).toBe(false);
  });

  it('annotates multicolumn cells and flags advanced constructs', () => {
    const m = w.tableBodyToModel(
      '\\multicolumn{2}{c}{Head} \\\\\nA & B \\\\\n\\cline{1-2}\n');
    expect(m.rows[0].cells[0].mc).toEqual({n: 2, spec: 'c'});
    expect(m.rows[0].cells[0].text).toBe('Head');
    expect(m.advanced).toBe(true);   // \cline
  });
});

describe('parseTableRich ↔ serializeTableRich round-trips', () => {
  const CASES = [
    ['bare tabular',
     '\\begin{tabular}{ll}\nA & B \\\\\nC & D \\\\\n\\end{tabular}'],
    ['booktabs rules',
     '\\begin{tabular}{lrr}\n\\toprule\nP & M & R \\\\\n\\midrule\n' +
     'E & 1.00 & 6371 \\\\\nM & 0.11 & 3390 \\\\\n\\bottomrule\n' +
     '\\end{tabular}'],
    ['wrapped table with caption above, label, centering',
     '\\begin{table}\n\\centering\n\\caption{Results.}\n\\label{tab:r}\n' +
     '\\begin{tabular}{lr}\nA & 1 \\\\\n\\end{tabular}\n\\end{table}'],
    ['caption below',
     '\\begin{table}\n\\begin{tabular}{ll}\nA & B \\\\\n\\end{tabular}\n' +
     '\\caption{Below.}\n\\end{table}'],
    ['multicolumn row',
     '\\begin{tabular}{ll}\n\\multicolumn{2}{c}{Head} \\\\\nA & B \\\\\n' +
     '\\end{tabular}'],
    ['tabularx with width argument',
     '\\begin{tabularx}{\\textwidth}{lX}\nA & B \\\\\n\\end{tabularx}'],
  ];

  it.each(CASES)('%s', (_name, src) => {
    const m = w.parseTableRich(src);
    expect(m, 'parseTableRich should accept').not.toBeNull();
    expect(w.serializeTableRich(m)).toBe(src);
  });

  it('a cell edit round-trips into the source', () => {
    const src = '\\begin{tabular}{ll}\nA & B \\\\\n\\end{tabular}';
    const m = w.parseTableRich(src);
    m.rows[0].cells[1].text = 'EDITED';
    expect(w.serializeTableRich(m)).toBe(
      '\\begin{tabular}{ll}\nA & EDITED \\\\\n\\end{tabular}');
  });

  it('rejects stray text around a bare tabular', () => {
    expect(w.parseTableRich('Note: this\n\\begin{tabular}{l}\nx \\\\\n' +
      '\\end{tabular}')).toBeNull();
  });

  it('rejects a table with no rows', () => {
    expect(w.parseTableRich('\\begin{tabular}{l}\n\\end{tabular}'))
      .toBeNull();
  });
});

describe('parseTabular (strict, grid-editing gate)', () => {
  const PLAIN = '\\begin{tabular}{ll}\nA & B \\\\\nC & D \\\\\n\\end{tabular}';

  it('parses a plain grid', () => {
    const t = w.parseTabular(PLAIN);
    expect(t.env).toBe('tabular');
    expect(t.colspec).toBe('ll');
    expect(t.grid).toEqual([['A', 'B'], ['C', 'D']]);
  });

  it('rejects booktabs rules and multicolumn', () => {
    expect(w.parseTabular(
      '\\begin{tabular}{ll}\n\\toprule\nA & B \\\\\n\\end{tabular}')
    ).toBeNull();
    expect(w.parseTabular(
      '\\begin{tabular}{ll}\n\\multicolumn{2}{c}{H} \\\\\n\\end{tabular}')
    ).toBeNull();
  });

  it('rejects text around the tabular (captions go to source editor)', () => {
    expect(w.parseTabular('\\begin{table}\n' + PLAIN + '\n\\end{table}'))
      .toBeNull();
  });
});

describe('parseTabularLenient (display-only)', () => {
  it('strips rules, unwraps multicolumn, keeps caption', () => {
    const t = w.parseTabularLenient(
      '\\begin{table}\n\\caption{Cap.}\n\\begin{tabular}{ll}\n\\toprule\n' +
      'A & B \\\\\n\\midrule\n\\multicolumn{2}{c}{H} \\\\\n\\bottomrule\n' +
      '\\end{tabular}\n\\end{table}');
    expect(t.grid).toEqual([['A', 'B'], ['H']]);
    expect(t.caption).toBe('Cap.');
  });
});
