// LaTeX dash rules in rendered text: --- em dash, -- en dash, a lone -
// stays a hyphen
import {describe, expect, it} from 'vitest';
import {loadApp} from './helpers/load-app.js';

const w = loadApp();
const R = src => w.renderInline(src);

describe('dash rendering', () => {
  it('--- renders an em dash', () => {
    expect(R('a---b')).toBe('a—b');
  });

  it('-- renders an en dash', () => {
    expect(R('2016--2025')).toBe('2016–2025');
  });

  it('a lone hyphen stays a hyphen', () => {
    expect(R('well-known')).toBe('well-known');
    expect(R('-start')).toBe('-start');
  });

  it('a triple run is em, not en', () => {
    expect(R('x----y')).toBe('x—-y');  // 4 hyphens: em + hyphen
  });

  it('escapes and commands are untouched', () => {
    expect(R('\\url{https://x/--y}')).toContain('/--y');
  });
});
