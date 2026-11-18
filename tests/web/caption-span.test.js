// captionSpan: the \caption{...} group of a figure/table source as a
// spliceable span — editing a caption rewrites ONLY that span, so the
// \label, graphics and the rest of the block stay byte-identical
import {describe, expect, it} from 'vitest';
import {loadApp} from './helpers/load-app.js';

const w = loadApp();

const FIG = [
  '\\begin{figure}[htbp]',
  '  \\centering',
  '  \\includegraphics[width=\\linewidth]{plot}',
  '  \\caption{Relative errors of flow thickness',
  '    and momentum against the reference.}',
  '  \\label{tab:verification-errors}',
  '\\end{figure}',
].join('\n');

describe('captionSpan', () => {
  it('extracts the body and the surrounding source', () => {
    const s = w.captionSpan(FIG);
    expect(s).not.toBeNull();
    expect(s.body).toBe('Relative errors of flow thickness\n    and momentum against the reference.');
    expect(s.pre).toContain('\\includegraphics');
    expect(s.pre.endsWith('\\caption{')).toBe(true);
    expect(s.post.startsWith('}')).toBe(true);
    expect(s.post).toContain('\\label{tab:verification-errors}');
  });

  it('splicing a new body preserves the rest byte-for-byte', () => {
    const s = w.captionSpan(FIG);
    const out = s.pre + 'New caption.' + s.post;
    expect(out).toContain('\\caption{New caption.}');
    expect(out).toContain('\\label{tab:verification-errors}');
    expect(out).toContain('\\includegraphics[width=\\linewidth]{plot}');
    expect(out).not.toContain('Relative errors');
    // braces stay balanced: the closing } of the group is kept
    expect((out.match(/}/g) || []).length).toBe((out.match(/\{/g) || []).length);
  });

  it('handles optional arguments \\caption[short]{body}', () => {
    const s = w.captionSpan('\\caption[short]{The body.}\\label{l}');
    expect(s.body).toBe('The body.');
    expect(s.pre.endsWith('\\caption[short]{')).toBe(true);
    expect(s.post).toBe('}\\label{l}');
  });

  it('returns null without a caption', () => {
    expect(w.captionSpan('\\begin{figure}\\centering\\end{figure}')).toBeNull();
  });
});
