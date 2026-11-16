// M4 — siunitx helpers: display units, math expansion, digit grouping
import {describe, expect, it} from 'vitest';
import {loadApp} from './helpers/load-app.js';

const w = loadApp();

describe('groupDigits', () => {
  it('groups from 4 digits up with thin spaces', () => {
    expect(w.groupDigits('1234')).toBe('1\u2009234');
    expect(w.groupDigits('1234567')).toBe('1\u2009234\u2009567');
  });

  it('leaves short numbers and non-numbers alone', () => {
    expect(w.groupDigits('123')).toBe('123');
    expect(w.groupDigits('abc')).toBe('abc');
    expect(w.groupDigits('12.5')).toBe('12.5');
  });

  it('keeps sign and decimal part ungrouped', () => {
    expect(w.groupDigits('-12345.678')).toBe('-12\u2009345.678');
  });
});

describe('renderUnit (display form)', () => {
  it('expands prefixed macros', () => {
    expect(w.renderUnit('\\kilo\\gram')).toBe('kg');
    expect(w.renderUnit('\\metre\\per\\second')).toBe('m/s');
  });

  it('superscript exponents', () => {
    expect(w.renderUnit('\\metre\\per\\second\\squared')).toBe('m/s²');
  });

  it('unit products become thin spaces', () => {
    expect(w.renderUnit('kg.m')).toBe('kg\u2009m');
  });
});

describe('siUnitToMath (KaTeX fragment)', () => {
  it('per builds negative exponents with thin-space joins', () => {
    expect(w.siUnitToMath('\\metre\\per\\second')).toBe('m\\,s^{-1}');
  });

  it('prefixes fuse onto unit symbols', () => {
    expect(w.siUnitToMath('\\kilo\\gram')).toBe('kg');
  });

  it('squared multiplies the previous unit exponent', () => {
    expect(w.siUnitToMath('\\metre\\per\\second\\squared'))
      .toBe('m\\,s^{-2}');
  });

  it('degree-leading units get a {} anchor for KaTeX', () => {
    expect(w.siUnitToMath('\\degreeCelsius')).toBe('{}^\\circ\\mathrm{C}');
  });
});

describe('expandSiunitxMath', () => {
  it('expands \\SI into value + \\mathrm unit', () => {
    expect(w.expandSiunitxMath('\\SI{9.81}{\\metre\\per\\second}'))
      .toBe('{9.81}\\,\\mathrm{m\\,s^{-1}}');
  });

  it('expands \\si, \\ang and \\num', () => {
    expect(w.expandSiunitxMath('\\si{\\kilo\\gram}'))
      .toBe('\\mathrm{kg}');
    expect(w.expandSiunitxMath('\\ang{90}')).toBe('{90}^{\\circ}');
    expect(w.expandSiunitxMath('\\num{12345}')).toBe('{12\\,345}');
  });

  it('skips siunitx options before the arguments', () => {
    expect(w.expandSiunitxMath('\\SI[per-mode=symbol]{1}{\\metre}'))
      .toBe('{1}\\,\\mathrm{m}');
  });

  it('leaves malformed input untouched (returns as-is)', () => {
    expect(w.expandSiunitxMath('\\SI{x}')).toBe('\\SI{x}');
    expect(w.expandSiunitxMath('no siunitx here')).toBe('no siunitx here');
  });

  it('does not match longer command names (\\SImore)', () => {
    expect(w.expandSiunitxMath('\\SImore{x}')).toBe('\\SImore{x}');
  });
});
