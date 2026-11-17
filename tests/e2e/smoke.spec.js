// M5 — end-to-end smoke: the real server, a real browser, a real copy of
// demo/. ~12 stable assertions covering the loop that must never break:
// render → edit-through-to-disk → undo → external-change reload → git
// panel → side-by-side. Selectors go through block data-id attributes.
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from '@playwright/test';
import {startServer} from './helpers/server.js';

let srv;

test.beforeAll(async () => { srv = await startServer(); });
test.afterAll(async () => { await srv?.stop(); });

test('the document renders and the websocket connects', async ({page}) => {
  await page.goto(srv.baseUrl);
  await expect(page).toHaveTitle(/TeXperiment/);
  // the connection pill drops conn-off once /ws is open
  await expect(page.locator('#conn')).not.toHaveClass(/conn-off/);
  // a healthy block render: demo parses into 30+ blocks
  const blocks = page.locator('#content .block');
  expect(await blocks.count()).toBeGreaterThan(10);
  // real content: the intro paragraph made it through the renderer
  await expect(page.locator('#content')).toContainText('live LaTeX editor');
});

async function currentDoc(srv) {
  return (await fetch(`${srv.baseUrl}/api/project/${srv.pid}/doc`)).json();
}

// Editing drives the raw side-by-side column: a fixed sidebar toggle
// (no hover timing), one contenteditable segment per block, and
// toggling back commits dirty files. The commit pipeline is honored
// exactly: the target segment keeps its trailing separator, and an
// input event starts the file's edit tracking (wireRawSeg listens for
// it). The block-level editors (dblclick inline contenteditable,
// hover-toolbar textarea) both have timing-sensitive caret/selection/
// hover behavior — TESTING.md register #13/#14 — and are not what the
// smoke suite rides on.
// the sbs toggle must actually activate before the suite proceeds — on a
// slow CI runner the first click can race the app's async init
async function enterSbsMode(page) {
  // the toolbar listener exists from the start, but the initial render is
  // async: wait for it so the click lands on a settled DOM
  await page.waitForFunction(
    () => document.querySelectorAll('#content .block').length > 10,
    null, {timeout: 15000});
  for (let i = 0; i < 3; i++) {
    await page.locator('#sbsbtn').click();
    try {
      await page.locator('.sbsrow').first()
        .waitFor({state: 'visible', timeout: 3000});
      return;
    } catch (e) { /* click swallowed or render slow — try once more */ }
  }
  throw new Error('side-by-side mode did not activate after 3 clicks');
}

async function editBlockViaRawColumn(page, rel, blockId, oldSource,
                                     newSource) {
  await enterSbsMode(page);
  const seg = page.locator(
    `.sbsfileseg[data-file="${rel}"][data-block-id="${blockId}"]`);
  await seg.waitFor({state: 'visible'});
  await page.evaluate(({rel: f, blockId: bid, newSrc, oldLen}) => {
    const el = document.querySelector(
      `.sbsfileseg[data-file="${f}"][data-block-id="${bid}"]`);
    // old segment text = source + trailing separator — keep the separator
    el.textContent = newSrc + el.textContent.slice(oldLen);
    el.dispatchEvent(new Event('input', {bubbles: true}));
  }, {rel, blockId, newSrc: newSource, oldLen: oldSource.length});
  const putPromise = page.waitForResponse(
    r => r.url().includes('/file') && r.request().method() === 'PUT');
  await page.locator('#sbsbtn').click();   // toggle away commits dirty files
  // bounded: when the app's editor-state races strike (register
  // #13/#14), fail fast so the configured retry gets a fresh shot
  const resp = await Promise.race([
    putPromise,
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('raw-column PUT never fired within 8s')), 8000)),
  ]);
  expect(resp.status()).toBe(200);
  await page.locator('.sbsfileseg').first()
    .waitFor({state: 'detached', timeout: 8000});
}

test('an edit through the raw column writes through to the .tex on disk',
  async ({page}) => {
    await page.goto(srv.baseUrl);
    // replace the chapter-two opening paragraph via the raw editor
    const doc = await currentDoc(srv);
    const para = doc.blocks.find(
      b => b.file === 'chapters/ch2.tex' && b.type === 'paragraph' &&
           b.source.replace(/^\s+/, '').startsWith('Chapter two arrives'));
    const newSrc = 'Chapter two, rewritten through the browser.';
    await editBlockViaRawColumn(page, 'chapters/ch2.tex', para.id, para.source, newSrc);
    // rendered view shows the new text
    await expect(page.locator('#content'))
      .toContainText('rewritten through the browser');
    // ...and the bytes on disk changed accordingly
    const disk = srv.readProjectFile('chapters/ch2.tex');
    expect(disk).toContain(newSrc);
    expect(disk).not.toContain('Chapter two arrives via');
  });

test('the git panel reports the changed file', async ({page}) => {
  await page.goto(srv.baseUrl);
  // the previous test's edit is on disk; the panel lists the change
  const panel = page.locator('#gitpanel');
  await expect(panel).toContainText(/ch2\.tex|modified|changed/i);
});

test('undo reverts the edit in the view and on disk', async ({page}) => {
  await page.goto(srv.baseUrl);
  // order-independent: edit the first ch2 paragraph as it is RIGHT NOW,
  // and require undo to restore the exact pre-edit bytes
  const doc = await currentDoc(srv);
  const para = doc.blocks.find(
    b => b.file === 'chapters/ch2.tex' && b.type === 'paragraph');
  const before = srv.readProjectFile('chapters/ch2.tex');
  await editBlockViaRawColumn(page, 'chapters/ch2.tex', para.id,
    para.source, 'A temporary edit to undo.');
  await expect(page.locator('#content')).toContainText('temporary edit');
  expect(srv.readProjectFile('chapters/ch2.tex')).not.toBe(before);

  // the server-side history must offer the undo before the button works
  const hist = await (await page.request.get(
    `${srv.baseUrl}/api/project/${srv.pid}/history`)).json();
  expect(hist.can_undo).toBe(true);

  await expect(page.locator('#undobtn')).toBeEnabled();
  const [resp] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/undo')),
    page.locator('#undobtn').click(),
  ]);
  expect(resp.status(), 'undo response: ' + await resp.text()).toBe(200);
  expect((await resp.json()).ok).toBe(true);
  await expect(page.locator('#content'))
    .not.toContainText('temporary edit', {timeout: 15000});
  // byte-for-byte the pre-edit state again
  expect(srv.readProjectFile('chapters/ch2.tex')).toBe(before);
});

test('select-all + type in the inline editor replaces the paragraph',
  async ({page}) => {
    await page.goto(srv.baseUrl);
    // order-independent: ch1's first \texttt paragraph is untouched by
    // the other tests
    const doc = await currentDoc(srv);
    const para = doc.blocks.find(
      b => b.file === 'chapters/ch1.tex' && b.type === 'paragraph' &&
           b.source.includes('\\texttt{'));
    const oldPrefix = para.source.slice(0, 18);
    const block = page.locator(`.block[data-id="${para.id}"]`);
    await block.dblclick();
    const ce = block.locator('.inline-ce');
    await ce.waitFor({state: 'visible'});
    // let the caret tracker's post-open rebuild settle before selecting —
    // CI timing showed element churn when interacting mid-rebuild (#14)
    await page.waitForTimeout(250);
    // the regression (TESTING.md #13): select-all must survive the caret
    // tracker, and typing must REPLACE rather than prepend
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Chapter one, replaced by select-all.',
      {delay: 5});
    await page.keyboard.press('Control+Enter');
    await ce.waitFor({state: 'detached'});
    await expect(page.locator('#content'))
      .toContainText('replaced by select-all');
    const disk = srv.readProjectFile('chapters/ch1.tex');
    expect(disk).toContain('Chapter one, replaced by select-all.');
    expect(disk).not.toContain(oldPrefix);
  });

test('an external file edit reloads the document over the websocket',
  async ({page}) => {
    await page.goto(srv.baseUrl);
    // a page reload would wipe this marker; it must still be set after
    // the live update arrives
    await page.evaluate(() => { window.__noReloadMarker = 1; });
    const marker = 'External browser reload marker paragraph.';
    appendFileSync(join(srv.projDir, 'chapters', 'ch1.tex'),
      '\r\n' + marker + '\r\n');
    // no page reload: the watcher broadcasts and the DOM updates itself
    await expect(page.locator('#content'))
      .toContainText(marker, {timeout: 15000});
    expect(await page.evaluate(() => window.__noReloadMarker)).toBe(1);
  });

test('side-by-side mode shows the raw source column', async ({page}) => {
  await page.goto(srv.baseUrl);
  await enterSbsMode(page);
  // raw file segments appear with their data-file attributes
  const seg = page.locator('.sbsfileseg[data-file]');
  expect(await seg.count()).toBeGreaterThan(2);
  // the raw column shows actual LaTeX source text (one segment per
  // block — the first main.tex segment is the preamble)
  await expect(page.locator('.sbsfileseg[data-file="main.tex"]').first())
    .toContainText('\\documentclass');
});
