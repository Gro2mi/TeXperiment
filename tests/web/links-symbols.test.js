// \url / \href render as real links; common text symbols map to unicode
import {describe, expect, it} from 'vitest';
import {loadApp} from './helpers/load-app.js';

const w = loadApp();
const R = src => w.renderInline(src);

describe('\\url renders as a clickable link', () => {
  it('http(s) urls become anchors with the url as text', () => {
    const html = R('\\url{https://example.com/?a=1&b=2}');
    expect(html).toContain('<a class="rtlink" href="https://example.com/?a=1&amp;b=2"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('>https://example.com/?a=1&amp;b=2</a>');
  });

  it('urls without a scheme stay a code chip', () => {
    expect(R('\\url{not-a-url}')).toBe('<code>not-a-url</code>');
  });
});

describe('\\href renders text hyperlinked to the url', () => {
  it('the text renders (nested commands allowed), linked', () => {
    const html = R('\\href{https://example.com}{\\textbf{docs}}');
    expect(html).toContain('<a class="rtlink" href="https://example.com"');
    expect(html).toContain('<strong>docs</strong></a>');
  });

  it('a non-http target renders the text without a link', () => {
    expect(R('\\href{mailto:x@y.z}{mail}')).toBe('mail');
  });
});

describe('common text symbols render as unicode', () => {
  it('copyright, registered, trademark, degree, euro', () => {
    expect(R('\\textcopyright')).toBe('©');
    expect(R('\\textregistered')).toBe('®');
    expect(R('\\texttrademark')).toBe('™');
    expect(R('\\textdegree')).toBe('°');
    expect(R('\\texteuro')).toBe('€');
  });

  it('dashes, quotes, ellipsis', () => {
    expect(R('\\textendash')).toBe('–');
    expect(R('\\textemdash')).toBe('—');
    expect(R('\\textellipsis')).toBe('…');
    // the source space between command and x renders as a space
    expect(R('\\textquotedblleft x\\textquotedblright')).toBe('“ x”');
    expect(R('\\textquotedblleft{}x\\textquotedblright')).toBe('“x”');
  });

  it('short forms: \\\\dag, \\\\S, \\\\P, \\\\dots, \\\\pound', () => {
    expect(R('\\dag')).toBe('†');
    expect(R('\\S')).toBe('§');
    expect(R('\\P')).toBe('¶');
    expect(R('\\dots')).toBe('…');
    expect(R('\\pound')).toBe('£');
  });

  it('symbols compose inside sentences and with markup', () => {
    expect(R('© 2024')).toBe('© 2024');   // literal, untouched
    expect(R('\\textbf{GPL\\textregistered}')).toBe('<strong>GPL®</strong>');
    expect(R('at 20\\textdegree{}C')).toBe('at 20°C');
  });

  it('unknown commands still chip (no false symbol match)', () => {
    expect(R('\\textnotasymbol')).toContain('cmdchip');
  });
});
