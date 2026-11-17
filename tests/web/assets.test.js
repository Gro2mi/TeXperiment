// M6 — cache-bust sanity: index.html hand-rolls ?v=N version query
// strings (bumped manually per change — a recurring source of stale-asset
// breakage). These checks catch the mechanical failure modes: a bumped
// reference that no longer resolves, and a self-hosted js/css asset
// referenced without a version at all.
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const webDir = join(dirname(fileURLToPath(import.meta.url)),
                    '..', '..', 'web');
const html = readFileSync(join(webDir, 'index.html'), 'utf8');

function refs(regex) {
  const out = [];
  for (const m of html.matchAll(regex)) out.push(m);
  return out;
}

describe('index.html cache-busted assets', () => {
  it('every ?v=N reference resolves to a real file', () => {
    const versioned = refs(/(?:src|href)="\/([^"?]+)\?v=(\d+)"/g);
    expect(versioned.length).toBeGreaterThanOrEqual(2);  // app.js + style.css
    for (const m of versioned) {
      const [, rel, v] = m;
      expect(existsSync(join(webDir, rel)), rel).toBe(true);
      expect(Number(v)).toBeGreaterThan(0);
    }
  });

  it('no self-hosted script/stylesheet is referenced unversioned', () => {
    // web/vendor/ is exempt: the third-party libs are pinned by the
    // sha256 manifest (fetch_vendor.py --check), not by query strings
    const bare = refs(/(?:src|href)="\/(?!vendor\/)[^"]+\.(?:js|css)"/g);
    expect(bare.map(m => m[0])).toEqual([]);
  });

  it('each versioned asset is referenced exactly once', () => {
    const versioned = refs(/(?:src|href)="\/([^"?]+)\?v=\d+"/g)
      .map(m => m[1]);
    expect(new Set(versioned).size).toBe(versioned.length);
  });
});
