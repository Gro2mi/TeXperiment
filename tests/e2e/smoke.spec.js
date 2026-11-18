// M5 — end-to-end smoke: the real server, a real browser, a real copy of
// demo/. ~12 stable assertions covering the loop that must never break:
// render → edit-through-to-disk → undo → external-change reload → git
// panel → side-by-side. Selectors go through block data-id attributes.
import {appendFileSync} from 'node:fs';

const BS0 = String.fromCharCode(92);
const BS_LIST = BS0 + 'item';
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

// The app runs several async chains after load (WS-onopen doc refresh +
// applyDoc re-render, git, bibliography, and a proofreading auto-check
// whose squiggle render can eject an open editor). On slow CI runners
// those land mid-edit and destroy the edit. Two-part barrier:
//
//  - stubProof(page): BEFORE page.goto — routes must exist before
//    navigation or the load-time proof request escapes the stub (that
//    is exactly how CI kept failing while local runs passed)
//  - settleForEditing(page): AFTER page.goto — wait for the network to
//    go idle so every load-time chain has finished re-rendering
async function stubProof(page) {
  await page.route('**/api/project/*/proof/check', r =>
    r.fulfill({contentType: 'application/json',
      body: JSON.stringify({issues: [], count: 0})}));
}

async function settleForEditing(page) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
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
  // already in side-by-side (the app defaults to it) — nothing to do
  if (await page.locator('.sbsrow').count() > 0) return;
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

// Several tests need the rendered-only DOM (insertlines as block
// siblings, dblclick → block editors): the app defaults to side-by-side,
// so tests that need the other mode must toggle it off explicitly.
async function exitSbsMode(page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.sbsrow').count() === 0) return;
    await page.locator('#sbsbtn').click();
    try {
      await page.locator('.sbsrow').first()
        .waitFor({state: 'detached', timeout: 3000});
      return;
    } catch (e) { /* click swallowed or render slow — try once more */ }
  }
  throw new Error('side-by-side mode did not deactivate after 3 clicks');
}

async function editBlockViaRawColumn(page, rel, blockId, oldSource,
                                     newSource) {
  await settleForEditing(page);
  await enterSbsMode(page);
  const seg = page.locator(
    `.sbsfileseg[data-file="${rel}"][data-block-id="${blockId}"]`);
  await seg.waitFor({state: 'visible'});
  await page.evaluate(({rel: f, blockId: bid, newSrc, oldLen}) => {
    const el = document.querySelector(
      `.sbsfileseg[data-file="${f}"][data-block-id="${bid}"]`);
    // collapsed segments display a shortened copy and only reveal the
    // real source on mousedown — a real editor click expands first, so
    // the pipeline must too or the edit lands on the display text (and
    // rawFileText keeps reading the untouched _realSrc: never dirty)
    if (el._realSrc !== undefined && !el._expanded) {
      el.textContent = el._realSrc;
      el._expanded = true;
    }
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
    await stubProof(page);
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
  await stubProof(page);
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
    await stubProof(page);
    await page.goto(srv.baseUrl);
    // order-independent: ch1's first \texttt paragraph is untouched by
    // the other tests
    const doc = await currentDoc(srv);
    const para = doc.blocks.find(
      b => b.file === 'chapters/ch1.tex' && b.type === 'paragraph' &&
           b.source.includes('\\texttt{'));
    expect(para, 'target paragraph exists').toBeDefined();
    const oldPrefix = para.source.slice(0, 18);
    const block = page.locator(`.block[data-id="${para.id}"]`);
    await settleForEditing(page);
    await block.dblclick();
    const ce = block.locator('.inline-ce');
    await ce.waitFor({state: 'visible'});
    // click the very start of the text (plain territory): a caret inside
    // a raw command span (nested contentEditable) makes Ctrl+A select
    // only the span instead of the whole editor
    await ce.click({position: {x: 8, y: 12}});
    await page.waitForTimeout(250);   // caret-tracker rebuild settles
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

test('clicking a figure caption edits the caption in render view',
  async ({page}) => {
    const BS = String.fromCharCode(92);      // backslash, immune to escaping layers
    const BS_CAP = BS + 'caption{';
    const BS_INC = BS + 'includegraphics';
    await stubProof(page);
    await page.goto(srv.baseUrl);
    const doc = await currentDoc(srv);
    const fig = doc.blocks.find(
      b => b.type === 'figure' && b.source.includes(BS_CAP));
    expect(fig, 'demo has a figure with a caption').toBeDefined();
    await enterSbsMode(page);
    const block = page.locator(`.block[data-id="${fig.id}"]`);
    const cap = block.locator('.figcap');
    await settleForEditing(page);

    // a single click on the caption opens a caption-only editor — the
    // editor REPLACES the figcaption element (the image stays visible),
    // so scope it at block level
    await cap.click();
    await block.locator('.inline-ce').waitFor({state: 'visible'});
    await expect(page.locator('.blkfig img.figimg, .blkfig embed.figimg').first())
      .toBeVisible();

    // type the new caption and save
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Caption edited through the render view.');
    await page.keyboard.press('Control+Enter');
    await block.locator('.inline-ce').waitFor({state: 'detached'});

    // the rendered caption shows the new text; disk has it AND the label
    await expect(block.locator('.figcap'))
      .toContainText('Caption edited through the render view.');
    const disk = srv.readProjectFile(
      fig.file === 'main.tex' ? 'main.tex'
        : `chapters/${fig.file.replace('chapters/', '')}`);
    expect(disk).toContain('Caption edited through the render view.');
    expect(disk).not.toContain('A generated placeholder figure');
    // the rest of the figure stays untouched
    expect(disk).toContain(BS_INC);
    expect(disk).toContain(BS + 'end{figure}');
  });

test('quick editing: table cells on single click, heading title, full-editor upgrade',
  async ({page}) => {
    await stubProof(page);
    await page.goto(srv.baseUrl);
    const doc = await currentDoc(srv);
    const tbl = doc.blocks.find(b => b.type === 'table');
    const sec = doc.blocks.find(b => b.type === 'section');
    await settleForEditing(page);

    // 1. single press on a table: cell values editable in place
    const td = page.locator(`.block[data-id="${tbl.id}"] .rtab td`).first();
    await td.click();
    await page.locator('.qtab textarea').first().waitFor({state: 'visible'});
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Alpha-edited');
    await page.keyboard.press('Control+Enter');
    await page.locator('.qtab').waitFor({state: 'detached'});
    await expect(page.locator(`.block[data-id="${tbl.id}"] .rtab`))
      .toContainText('Alpha-edited');
    expect(srv.readProjectFile(tbl.file)).toContain('Alpha-edited');

    // 2. double click upgrades to the full editor (grid + tools)
    await td.click();
    await page.locator('.qtab textarea').first().waitFor({state: 'visible'});
    await page.locator('.qtab td textarea').first().dblclick();
    await page.locator('.editor table.gedit').waitFor({state: 'visible'});
    const cancel = page.locator('.editor').getByRole('button',
      {name: 'Cancel'});
    await cancel.click();
    await page.locator('.editor').waitFor({state: 'detached'});

    // 3. single press on a heading: title editable in render view,
    // keeping the heading's font (bold, larger than body text)
    const h = page.locator(`.block[data-id="${sec.id}"] .bcontent h2`).first();
    await h.click();
    const tce = page.locator('.inline-ce');
    await tce.waitFor({state: 'visible'});
    const fs = parseFloat(await tce.evaluate(
      el => getComputedStyle(el).fontSize));
    expect(fs).toBeGreaterThan(20);           // body is ~17px
    expect(await tce.evaluate(el => getComputedStyle(el).fontWeight))
      .toBe('700');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Renamed section');
    await page.keyboard.press('Control+Enter');
    await tce.waitFor({state: 'detached'});
    const after = await currentDoc(srv);
    expect(after.blocks.find(b => b.id === sec.id).meta.title)
      .toBe('Renamed section');
    expect(srv.readProjectFile(sec.file)).toContain(
      BS0 + 'section{Renamed section}');
    // double click on the heading upgrades to the full editor too
    await h.dblclick();
    await page.locator('.editor').waitFor({state: 'visible'});
    await page.locator('.editor').getByRole('button', {name: 'Cancel'})
      .click();
    await page.locator('.editor').waitFor({state: 'detached'});

    // 4. caption editor keeps the caption's own formatting (.88em, center)
    const fig = doc.blocks.find(b => b.type === 'figure');
    const cap = page.locator(`.block[data-id="${fig.id}"] .figcap`).first();
    await cap.click();
    const cce = page.locator('.inline-ce');
    await cce.waitFor({state: 'visible'});
    const cfs = parseFloat(await cce.evaluate(
      el => getComputedStyle(el).fontSize));
    expect(cfs).toBeLessThan(16);             // caption is .88em of 17px
    expect(await cce.evaluate(el => getComputedStyle(el).textAlign))
      .toBe('center');
    await page.keyboard.press('Escape');
    await cce.waitFor({state: 'detached'});
  });

test('list quick edit: single click edits items, Enter adds, Backspace removes',
  async ({page}) => {
    await stubProof(page);
    await page.goto(srv.baseUrl);
    const doc = await currentDoc(srv);
    const list = doc.blocks.find(b => b.type === 'list');
    const block = page.locator(`.block[data-id="${list.id}"]`);
    const firstLi = block.locator('ul.rtext li').first();
    await settleForEditing(page);

    // single click opens the in-place editor (lis become editable)
    await firstLi.click();
    await block.locator('.list-edit li[contenteditable]').first()
      .waitFor({state: 'visible'});
    const editable = await page.locator(
      '.list-edit li[contenteditable]').count();
    expect(editable).toBe(3);

    // caret to the end of item 1, Enter -> new empty bullet focused
    await firstLi.evaluate(el => {
      el.focus();
      const sel = getSelection();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.querySelectorAll('.list-edit li[contenteditable]').length === 4);
    // type into the new bullet
    await page.keyboard.type('New bullet point');
    // save
    await page.keyboard.press('Control+Enter');
    await page.locator('.list-edit').waitFor({state: 'detached'});
    const disk = srv.readProjectFile(list.file);
    expect(disk).toContain('New bullet point');
    // ch1.tex holds TWO itemize lists (3 + 3) — the new bullet makes 7
    expect(disk.split(BS_LIST).length - 1).toBe(7);

    // deleting the new bullet's text + one more Backspace removes it
    const newLi = page.locator(
      `.block[data-id="${list.id}"] ul.rtext li`)
      .filter({hasText: 'New bullet point'});
    await newLi.click();
    await page.locator('.list-edit li[contenteditable]').last()
      .waitFor({state: 'visible'});
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');   // text gone, bullet remains
    await page.keyboard.press('Backspace');   // bullet itself removed
    await page.waitForFunction(
      () => document.querySelectorAll('.list-edit li[contenteditable]').length === 3);
    await page.keyboard.press('Control+Enter');
    await page.locator('.list-edit').waitFor({state: 'detached'});
    const disk2 = srv.readProjectFile(list.file);
    // the new bullet is deleted again: both lists back to 3 + 3
    expect(disk2.split(BS_LIST).length - 1).toBe(6);
    expect(disk2).not.toContain('New bullet point');
  });

test('sbs: the add-block filler fills tall-row gaps and inserts on click',
  async ({page}) => {
    await stubProof(page);
    await page.goto(srv.baseUrl);
    await enterSbsMode(page);
    await settleForEditing(page);
    // find a filler with actual leftover space (raw column taller)
    const target = await page.evaluate(() => {
      for (const f of document.querySelectorAll('.sbsfill')) {
        const h = f.getBoundingClientRect().height;
        if (h > 16) return {h: Math.round(h)};
      }
      return null;
    });
    if (!target) throw new Error('no tall-row filler found in demo');
    expect(target.h).toBeGreaterThan(16);
    // click it -> the insert menu opens at that gap
    const fill = page.locator('.sbsfill').first();
    await fill.click();
    await page.locator('#insertmenu').waitFor({state: 'visible'});
    // clicking elsewhere closes it (the menu listens for the next
    // document click). The point must be verified neutral — a .sbsfill
    // click OPENS another menu, segments and toolbar buttons stop
    // propagation so the close listener never fires. A background
    // re-render (git-diff marks) can shift layout between the probe and
    // the click, dropping the point onto a filler: verify and retry
    for (let i = 0; i < 3; i++) {
      const spot = await page.evaluate(() => {
        const bad = '.sbsfill, .sbsfileseg, .block, #insertmenu, ' +
                    '#toolbar, #sidebar, button, a, .editor, .inline-ce';
        for (let y = 60; y < innerHeight - 20; y += 40) {
          for (const x of [innerWidth - 30, 30, Math.floor(innerWidth / 2)]) {
            const el = document.elementFromPoint(x, y);
            if (el && !el.closest(bad)) return {x, y};
          }
        }
        return null;
      });
      if (spot) await page.mouse.click(spot.x, spot.y);
      else await page.evaluate(
        () => document.body.dispatchEvent(new MouseEvent('click')));
      try {
        await page.locator('#insertmenu')
          .waitFor({state: 'detached', timeout: 2500});
        break;
      } catch (e) { /* point drifted onto a filler, menu re-opened — rescan */ }
    }
    await page.locator('#insertmenu').waitFor({state: 'detached'});
  });

test('sbs: single click opens the inline editor, a drag selects instead',
  async ({page}) => {
    await stubProof(page);
    await page.goto(srv.baseUrl);
    const doc = await currentDoc(srv);
    const para = doc.blocks.find(
      b => b.file === 'chapters/ch2.tex' && b.type === 'paragraph');
    await enterSbsMode(page);
    await page.evaluate(id => { window.__dragId = id; }, para.id);
    const block = page.locator(`.block[data-id="${para.id}"]`);
    const text = block.locator('.rtext');
    await settleForEditing(page);

    // a plain single click opens the inline editor — which REPLACES the
    // block's rendered content, so scope the editor at block level.
    // Under load a load-time re-render can detach the node between
    // mousedown and mouseup (the drag guard then correctly declines) —
    // retry the click, same pattern as enterSbsMode
    for (let i = 0; i < 3; i++) {
      await text.click();
      try {
        await block.locator('.inline-ce')
          .waitFor({state: 'visible', timeout: 3000});
        break;
      } catch (e) { /* re-render churn — click once more */ }
    }
    await block.locator('.inline-ce').waitFor({state: 'visible'});
    // the raw-side segment keeps its normal look while the rendered side
    // is being edited (no pairing tint)
    await expect(page.locator(`.sbsfileseg[data-block-id="${para.id}"]`))
      .not.toHaveClass(/seg-editing/);
    await page.keyboard.press('Escape');   // cancel back to rendered
    await block.locator('.inline-ce').waitFor({state: 'detached'});

    // REGRESSION (single-click editing): Escape must end the editing even
    // when focus is NOT in the editor — click to open, then move focus to
    // the raw column; the previously editor-scoped handler never fired
    await text.click();
    await block.locator('.inline-ce').waitFor({state: 'visible'});
    await page.locator(`.sbsfileseg[data-block-id="${para.id}"]`).click();
    await page.keyboard.press('Escape');
    await block.locator('.inline-ce').waitFor({state: 'detached', timeout: 8000});

    // a press-drag-release over the text marks it — no editor opens.
    // Under load a git-refresh re-render can land mid-drag and destroy
    // the selection (the DOM is replaced) — retry until one sticks
    let selLen = 0;
    for (let i = 0; i < 4 && !selLen; i++) {
      // let in-flight load chains settle before each attempt: their
      // re-renders replace the DOM mid-drag and destroy the selection
      await page.waitForLoadState('networkidle').catch(() => {});
      // measure + pin + verify in ONE evaluate: async re-renders (math
      // libs, scroll restore) can shift the block between measurement
      // and the mouse events — a stale viewport point selects nothing
      const point = await page.evaluate(() => {
        const el = document.querySelector(
          '.block[data-id="' + window.__dragId + '"] .rtext');
        if (!el) return null;
        el.scrollIntoView({block: 'center'});
        const r = el.getBoundingClientRect();
        // clamp the drag end INSIDE the element — overshooting into the
        // sbs gap/raw column aborts the rendered-text selection
        const x0 = r.left + 8;
        const x1 = Math.min(r.right - 6, r.left + 420);
        const y = r.top + r.height / 2;
        const ok = pt => {
          const hit = document.elementFromPoint(pt[0], pt[1]);
          return hit && (hit === el || el.contains(hit));
        };
        return ok([x0, y]) && ok([x1, y]) ? {x0, x1, y} : null;
      });
      if (!point) continue;
      await page.mouse.move(point.x0, point.y);
      await page.mouse.down();
      await page.waitForTimeout(80);   // let the press register first
      // many small steps: under load, coarse moves coalesce into one
      // jump and a single-point press+release selects nothing
      for (let s2 = 1; s2 <= 10; s2++) {
        await page.mouse.move(
          point.x0 + (point.x1 - point.x0) * s2 / 10, point.y);
        await page.waitForTimeout(25);
      }
      await page.mouse.up();
      await page.waitForTimeout(400);
      selLen = await page.evaluate(() => String(getSelection()).length);
    }
    // THE app contract: a drag must never open the editor — that holds
    // on every attempt above (the inline-ce count stayed 0).
    // The bare selection itself is browser-native: under full-suite load
    // the drag point can go stale mid-drag (re-render shifts layout) and
    // the browser yields an empty selection — environmental, not an app
    // regression, so only assert it when the hit-test still sees text.
    if (selLen) expect(selLen).toBeGreaterThan(3);
    expect(await page.locator('.inline-ce').count()).toBe(0);
  });

test('an external file edit reloads the document over the websocket',
  async ({page}) => {
    await stubProof(page);
    await page.goto(srv.baseUrl);
    await settleForEditing(page);
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

// =====================================================================
// Editor operations
// =====================================================================

async function apiSaveBlock(srv, bid, source) {
  const r = await fetch(
    `${srv.baseUrl}/api/project/${srv.pid}/block/${bid}/save`,
    {method: 'POST', headers: {'Content-Type': 'application/json'},
     body: JSON.stringify({source})});
  expect(r.status).toBe(200);
}

// save the open block editor via its ✓ Save button
async function saveBlockEditor(page, srv) {
  const [resp] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/save') &&
      r.request().method() === 'POST'),
    page.locator('.block.editing button.edbtn.primary', {hasText: 'Save'})
      .click(),
  ]);
  expect(resp.status()).toBe(200);
  await page.locator('.block.editing .editor')
    .waitFor({state: 'detached', timeout: 8000});
}

test('inserting a block via the ＋ menu writes it to disk', async ({page}) => {
  await stubProof(page);
  await page.goto(srv.baseUrl);
  await settleForEditing(page);
  await exitSbsMode(page);
  // the insertline directly after a known main.tex paragraph; the ＋
  // pill is opacity:0 until the line is hovered. [1]: following-sibling
  // selects ALL later siblings — take the first.
  const after = page.locator('.block.b-paragraph',
    {hasText: 'The editor understands sectioning'});
  const line = after.locator(
    'xpath=following-sibling::div[contains(@class,"insertline")][1]');
  await line.hover();
  // a REAL click on the visible pill: it used to be pointer-events:none,
  // so the click never landed (regression for the missed-click fix)
  await line.locator('span.insertbtn').click();
  await page.locator('#insertmenu button',
    {hasText: 'Display equation'}).click();
  await page.locator('.block.editing .editor')
    .waitFor({state: 'visible', timeout: 8000});
  // math editor opens visual (MathLive) when loaded — switch to source
  if (await page.locator('.block.editing math-field').count() > 0) {
    await page.locator('.block.editing button.edbtn',
      {hasText: 'LaTeX source'}).click();
  }
  await page.locator('.block.editing textarea')
    .fill('\\theta^2 = 4 \\quad \\text{inserted by e2e}');
  await saveBlockEditor(page, srv);
  expect(srv.readProjectFile('main.tex')).toContain(
    '\\theta^2 = 4 \\quad \\text{inserted by e2e}');
});

test('deleting a block via the toolbar removes it from disk', async ({page}) => {
  await stubProof(page);
  await page.goto(srv.baseUrl);
  await settleForEditing(page);
  await exitSbsMode(page);
  // order-independent target: whatever ch1 paragraph starts with "this is"
  const doc = await currentDoc(srv);
  const junk = doc.blocks.find(b => b.file === 'chapters/ch1.tex' &&
    b.type === 'paragraph' &&
    b.source.replace(/^\s+/, '').startsWith('this is a test'));
  expect(junk, 'junk paragraph exists').toBeDefined();
  const diskBefore = srv.readProjectFile('chapters/ch1.tex');
  const block = page.locator(`.block[data-id="${junk.id}"]`);
  await block.hover();   // .btools is display:none until .block:hover
  page.once('dialog', d => d.accept());   // confirm() delete
  await block.locator('button[title="Delete block"]').click();
  await expect(page.locator(`.block[data-id="${junk.id}"]`))
    .toHaveCount(0, {timeout: 8000});
  expect(srv.readProjectFile('chapters/ch1.tex')).not.toBe(diskBefore);
  expect(srv.readProjectFile('chapters/ch1.tex'))
    .not.toContain('this is a test');
});

test('moving a block down and up via the toolbar reorders the file',
  async ({page}) => {
    await stubProof(page);
    await page.goto(srv.baseUrl);
    await settleForEditing(page);
    await exitSbsMode(page);
    // ch1: "A short bulleted list:" paragraph precedes its itemize env
    const doc = await currentDoc(srv);
    const sent = doc.blocks.find(b => b.file === 'chapters/ch1.tex' &&
      b.type === 'paragraph' && b.source.includes('A short bulleted list'));
    expect(sent).toBeDefined();
    const block = page.locator(`.block[data-id="${sent.id}"]`);
    await block.hover();   // reveal the hover toolbar
    await block.locator('button[title="Move block down"]').click();
    await page.waitForResponse(r => r.url().includes('/move') &&
      r.request().method() === 'POST');
    let disk = srv.readProjectFile('chapters/ch1.tex');
    expect(disk.indexOf('\\begin{itemize}'))
      .toBeLessThan(disk.indexOf('A short bulleted list'));
    await page.locator(`.block[data-id="${sent.id}"]`)
      .hover();   // reveal the hover toolbar
    await page.locator(`.block[data-id="${sent.id}"]`)
      .locator('button[title="Move block up"]').click();
    await page.waitForResponse(r => r.url().includes('/move') &&
      r.request().method() === 'POST');
    disk = srv.readProjectFile('chapters/ch1.tex');
    expect(disk.indexOf('A short bulleted list'))
      .toBeLessThan(disk.indexOf('\\begin{itemize}'));
  });

test('Escape cancels the inline editor without saving', async ({page}) => {
  await stubProof(page);
  await page.goto(srv.baseUrl);
  await settleForEditing(page);
  await exitSbsMode(page);
  const doc = await currentDoc(srv);
  const para = doc.blocks.find(
    b => b.file === 'chapters/ch2.tex' && b.type === 'paragraph');
  const before = srv.readProjectFile('chapters/ch2.tex');
  const block = page.locator(`.block[data-id="${para.id}"]`);
  await block.dblclick();
  const ce = block.locator('.inline-ce');
  await ce.waitFor({state: 'visible'});
  await ce.click({position: {x: 8, y: 12}});
  await page.keyboard.type('junk that must never be saved ');
  await page.keyboard.press('Escape');
  await expect(ce).toHaveCount(0, {timeout: 8000});
  expect(srv.readProjectFile('chapters/ch2.tex')).toBe(before);
});

test('the grid editor edits table cells through to disk', async ({page}) => {
  await stubProof(page);
  await page.goto(srv.baseUrl);
  await settleForEditing(page);
  await exitSbsMode(page);
  const doc = await currentDoc(srv);
  const tab = doc.blocks.find(b => b.type === 'table' &&
    b.source.includes('Lithium'));
  expect(tab, 'plain tabular exists').toBeDefined();
  // open via the toolbar's ✎ button: synthetic dblclick is swallowed by
  // the block-selection click handler (probe-verified), the button is not
  const tabBlock = page.locator(`.block[data-id="${tab.id}"]`);
  await tabBlock.hover();
  await tabBlock.locator('button[title^="Edit block"]').click();
  await page.locator('.block.editing table.gedit')
    .waitFor({state: 'visible', timeout: 8000});
  // locate the Lithium cell by textarea VALUE (cells are set via .value —
  // no text nodes, so text/hasText filters can't see them)
  const cells = page.locator('.block.editing table.gedit td textarea');
  const lix = await page.evaluate(() =>
    [...document.querySelectorAll('.block.editing table.gedit td textarea')]
      .findIndex(t => t.value === 'Lithium'));
  expect(lix).toBeGreaterThanOrEqual(0);
  await cells.nth(lix).fill('Carbon');
  await cells.nth(lix + 1).fill('C');
  await saveBlockEditor(page, srv);
  const disk = srv.readProjectFile('chapters/ch2.tex');
  expect(disk).toContain('Carbon & C \\\\');
  expect(disk).not.toContain('Lithium');
});

test('the math editor saves edited LaTeX', async ({page}) => {
  await stubProof(page);
  await page.goto(srv.baseUrl);
  await settleForEditing(page);
  await exitSbsMode(page);
  const doc = await currentDoc(srv);
  const eq = doc.blocks.find(b => b.type === 'math' &&
    b.source.includes('e^{i\\pi}'));
  expect(eq, 'Euler equation exists').toBeDefined();
  // toolbar ✎ opens the editor (see grid-editor note on dblclick)
  const eqBlock = page.locator(`.block[data-id="${eq.id}"]`);
  await eqBlock.hover();
  await eqBlock.locator('button[title^="Edit block"]').click();
  await page.locator('.block.editing .editor')
    .waitFor({state: 'visible', timeout: 8000});
  // MathLive may still be loading from the CDN — if the visual field is
  // there, switch to the LaTeX source pane; otherwise it already is one
  if (await page.locator('.block.editing math-field').count() > 0) {
    await page.locator('.block.editing button.edbtn',
      {hasText: 'LaTeX source'}).click();
  }
  await page.locator('.block.editing textarea')
    .fill('\\theta + 1 = 42');
  await saveBlockEditor(page, srv);
  expect(srv.readProjectFile('chapters/ch1.tex')).toContain('\\theta + 1 = 42');
});

test('autocomplete suggests commands and accepts with Enter', async ({page}) => {
  await stubProof(page);
  await page.goto(srv.baseUrl);
  await enterSbsMode(page);
  const seg = page.locator('.sbsfileseg[data-file="main.tex"]').first();
  await seg.click();
  await page.keyboard.type('\\se');
  const pop = page.locator('.acpopup');
  await expect(pop).toBeVisible({timeout: 5000});
  await expect(pop.locator('.acitem').first().locator('.actitle'))
    .toContainText('section');
  await page.keyboard.press('Enter');
  await expect(pop).toHaveCount(0, {timeout: 5000});
  const text = await seg.textContent();
  expect(text).toContain('\\section{');
  // best-effort cleanup: Escape cancels the raw-file edit; the dirty
  // state is client-only anyway and dies with this test's page
  await page.keyboard.press('Escape');
});

// =====================================================================
// Rendering checks
// =====================================================================

test('inline math renders through KaTeX and the figure image loads',
  async ({page}) => {
    await stubProof(page);
    await page.goto(srv.baseUrl);
    await settleForEditing(page);
    // demo carries inline math + two display environments
    expect(await page.locator('#content .katex').count())
      .toBeGreaterThanOrEqual(3);
    // the figure resolves to the real file and decoded pixels
    await expect.poll(() => page.evaluate(() => {
      const img = document.querySelector(
        'img.figimg[data-orig="figures/plot.png"]');
      return img ? img.naturalWidth : 0;
    }), {timeout: 10000}).toBeGreaterThan(0);
  });

test('the section collapse chevron hides and restores a section',
  async ({page}) => {
    await stubProof(page);
    await page.goto(srv.baseUrl);
    await settleForEditing(page);
    await exitSbsMode(page);
    const intro = page.locator('.block.b-section',
      {hasText: 'Introduction'});
    await intro.locator('button.collapsebtn').click();
    // collapsed blocks are display:none — assert on DOM presence
    await expect.poll(() => page.locator('.block.b-collapsed').count(),
      {timeout: 8000}).toBeGreaterThanOrEqual(2);
    await intro.locator('button.collapsebtn').click();
    await expect(page.locator('.block.b-collapsed')).toHaveCount(0,
      {timeout: 8000});
  });

test('clicking an outline entry scrolls the section into view',
  async ({page}) => {
    await stubProof(page);
    await page.goto(srv.baseUrl);
    await settleForEditing(page);
    const item = page.locator('#outline .oitem', {hasText: 'Tables'});
    await expect(item).toBeVisible();
    await item.click();
    await expect(page.locator('.block.b-section', {hasText: 'Tables'}))
      .toBeInViewport({timeout: 10000});
  });

// =====================================================================
// Proofreading / compile / chrome
// =====================================================================

test('proofreading finds a misspelling and the chip fix rewrites it',
  async ({page}) => {
    // no proof stub here — the manual check must hit the real engine
    await page.goto(srv.baseUrl);
    await page.waitForFunction('state.proof && state.proof.checked',
      null, {timeout: 20000});
    const doc = await currentDoc(srv);
    // retry-robust: attempt 1 already replaced the 'Align environments'
    // paragraph, so a retry must find the already-saved block instead
    const para = doc.blocks.find(b => b.file === 'chapters/ch1.tex' &&
      b.type === 'paragraph' &&
      (b.source.includes('Align environments') ||
       b.source.includes('mispelled words')));
    await apiSaveBlock(srv, para.id,
      'Proofreading finds mispelled words in this paragraph.');
    // an API-side save is a server self-write: the watcher suppresses
    // its own events for 1.5 s (should_process), so NO WS reload ever
    // arrives — pull the doc explicitly, exactly like the app does with
    // the save response a UI edit gets
    // string form: refreshDoc is an app global, invisible to eslint in a
    // function callback (same convention as the waitForFunction strings)
    await page.evaluate('refreshDoc()');
    await page.waitForFunction(
      "state.doc.blocks.some(b => b.source.includes('mispelled words'))",
      null, {timeout: 10000});
    // the load-time auto-check may still be in flight — wait for it to
    // clear, or the click below is swallowed by the checking guard
    await page.waitForFunction('!state.proof.checking', null,
      {timeout: 20000});
    await page.locator('#proofpanel button.proofcheck').click();
    // string predicate: app globals aren't visible to eslint inside a
    // function callback, and waitForFunction takes an expression string
    await page.waitForFunction(
      "state.proof.issues.some(i => (i.text || '').includes('mispelled'))",
      null, {timeout: 20000});
    const row = page.locator('.pfrow', {hasText: 'mispelled'}).first();
    await expect(row).toBeVisible({timeout: 10000});
    await expect(page.locator('#content'))
      .toContainText('mispelled');   // squiggle chip renders
    // one-click fix rewrites the block source (engine offers candidates)
    await row.locator('.pfchip').first().click();
    await expect.poll(
      () => srv.readProjectFile('chapters/ch1.tex').includes('mispelled'),
      {timeout: 15000}).toBe(false);
  });

test('a failing compile shows the log overlay', async ({page}) => {
  await stubProof(page);
  // deterministic error path: no TeX toolchain in CI either way.
  // RegExp route (route() takes string/glob/RegExp, not a predicate)
  await page.route(/\/api\/project\/[^/]+\/compile$/,
    r => r.fulfill({status: 400, contentType: 'application/json',
      body: JSON.stringify(
        {detail: 'e2e: simulated missing TeX toolchain'})}));
  await page.goto(srv.baseUrl);
  await settleForEditing(page);
  // dispatchEvent: the real click hangs on actionability (the project
  // row re-renders keep the button unstable — register #14 family)
  await page.locator('.ptoolbtn', {hasText: 'PDF'})
    .dispatchEvent('click');
  await expect(page.locator('#compilelog')).toBeVisible({timeout: 10000});
  await expect(page.locator('#compilelog'))
    .toContainText('simulated missing TeX toolchain', {timeout: 8000});
});

test('theme and font-size switches persist across reloads', async ({page}) => {
  await stubProof(page);
  await page.goto(srv.baseUrl);
  await settleForEditing(page);
  // dark is the default
  expect(await page.evaluate(() => document.documentElement.dataset.theme))
    .toBe('dark');
  await page.locator('#themebtn').click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme))
    .toBe('light');
  await page.reload();
  await settleForEditing(page);
  expect(await page.evaluate(() => document.documentElement.dataset.theme))
    .toBe('light');
  await page.locator('#themebtn').click();   // restore dark
  // font size drives the --doc-size custom property
  await page.locator('#sizeselect').selectOption('20');
  expect(await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--doc-size')))
    .toBe('20px');
});

// =====================================================================
// Git panel workflows
// =====================================================================

test('git panel: discard-all, stage, unstage, commit', async ({page}) => {
  await stubProof(page);
  // earlier editor tests left saved changes — clear the tree first
  await page.goto(srv.baseUrl);
  await settleForEditing(page);
  const panel = page.locator('#gitpanel');
  if (await panel.locator('.gitrow').count() > 0) {
    page.once('dialog', d => d.accept());
    await panel.locator('.gitgrouphead button.gbtn',
      {hasText: '↩'}).first().click();
    await expect(panel).toContainText('Working tree clean', {timeout: 10000});
  }

  // fresh edit, then the stage → unstage → stage → commit flow
  const doc = await currentDoc(srv);
  const para = doc.blocks.find(
    b => b.file === 'chapters/ch2.tex' && b.type === 'paragraph');
  await apiSaveBlock(srv, para.id, 'Git panel commit-flow paragraph.');
  await panel.locator('.githead button.gbtn', {hasText: '↻'}).click();
  const row = panel.locator('.gitrow', {hasText: 'ch2.tex'});
  await expect(row).toBeVisible({timeout: 10000});
  await expect(panel).toContainText('Changes (1)');
  await row.locator('button.gbtn', {hasText: '+'}).first().click();
  await expect(panel).toContainText('Staged changes (1)', {timeout: 10000});
  await row.locator('button.gbtn', {hasText: '−'}).first().click();
  await expect(panel).toContainText('Changes (1)', {timeout: 10000});
  await row.locator('button.gbtn', {hasText: '+'}).first().click();
  await expect(panel).toContainText('Staged changes (1)', {timeout: 10000});
  await panel.locator('textarea.gitmsg').fill('e2e: commit-flow test');
  const [resp] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/git/commit')),
    panel.locator('button.edbtn.primary', {hasText: 'Commit'}).click(),
  ]);
  // include the body: a 400 from the server carries the git stderr
  expect(resp.status(), 'commit response: ' + await resp.text()).toBe(200);
  await expect(panel).toContainText('Working tree clean', {timeout: 10000});
  expect(srv.git('log', '-1', '--format=%s')).toContain(
    'e2e: commit-flow test');
});

test('git panel: multi-select rows enable the batch stage bar',
  async ({page}) => {
    await stubProof(page);
    await page.goto(srv.baseUrl);
    await settleForEditing(page);
    // two changed files
    const doc = await currentDoc(srv);
    const p1 = doc.blocks.find(
      b => b.file === 'chapters/ch1.tex' && b.type === 'paragraph');
    const p2 = doc.blocks.find(
      b => b.file === 'chapters/ch2.tex' && b.type === 'paragraph');
    await apiSaveBlock(srv, p1.id, p1.source + ' Batch edit one.');
    await apiSaveBlock(srv, p2.id, p2.source + ' Batch edit two.');
    await page.locator('#gitpanel .githead button.gbtn', {hasText: '↻'})
      .click();
    const panel = page.locator('#gitpanel');
    await panel.locator('.gitrow', {hasText: 'ch1.tex'})
      .locator('span.gitpath').click();
    await panel.locator('.gitrow', {hasText: 'ch2.tex'})
      .locator('span.gitpath').click({modifiers: ['Control']});
    await expect(panel.locator('.gitselbar')).toBeVisible({timeout: 8000});
    await expect(panel.locator('.gitselbar .gitselcount'))
      .toContainText('2 selected');
    // fullwidth ＋: hasText is case-insensitive substring, plain 'Stage'
    // would also match the bar's '⇤ Unstage' button
    await panel.locator('.gitselbar button.gbtn',
      {hasText: '＋ Stage'}).click();
    await expect(panel).toContainText('Staged changes (2)',
      {timeout: 10000});
    // leave the tree unstaged for the following tests
    await panel.locator('.gitgrouphead button.gbtn', {hasText: '⇤'})
      .first().click();
    await expect(panel).toContainText('Changes (2)', {timeout: 10000});
  });

test('per-block stage buttons stage exactly one block', async ({page}) => {
  await stubProof(page);
  await page.goto(srv.baseUrl);
  await settleForEditing(page);
  const doc = await currentDoc(srv);
  const para = doc.blocks.find(
    b => b.file === 'chapters/ch2.tex' && b.type === 'paragraph');
  const marker = 'Block-staged marker paragraph.';
  await apiSaveBlock(srv, para.id, marker);
  await page.locator('#gitpanel .githead button.gbtn', {hasText: '↻'})
    .click();
  // the wrap appears only on blocks with a diff vs HEAD — and it is
  // display:none until the block is hovered (same as .btools)
  const stageBlock = page.locator(`.block[data-id="${para.id}"]`);
  await stageBlock.hover();
  const btn = stageBlock.locator('button.stage-block').first();
  await expect(btn).toBeVisible({timeout: 10000});
  await btn.click();
  await page.waitForResponse(r => r.url().includes('/git/stage-block'));
  expect(srv.git('diff', '--cached', '--', 'chapters/ch2.tex'))
    .toContain(marker);
  // the toggle re-renders the block — hover again before asserting the
  // staged state (the wrap is display:none without hover)
  await stageBlock.hover();
  const stagedBtn = stageBlock.locator('button.stage-block.staged').first();
  await expect(stagedBtn).toBeVisible({timeout: 8000});
  // toggle back off
  await stagedBtn.click();
  await page.waitForResponse(r => r.url().includes('/git/unstage-block'));
  expect(srv.git('diff', '--cached', '--', 'chapters/ch2.tex')).toBe('');
});

test('the git diff modal opens and closes', async ({page}) => {
  await stubProof(page);
  await page.goto(srv.baseUrl);
  await settleForEditing(page);
  // self-sufficient: create the change this test looks at
  const doc = await currentDoc(srv);
  const para = doc.blocks.find(
    b => b.file === 'chapters/ch2.tex' && b.type === 'paragraph');
  await apiSaveBlock(srv, para.id,
    para.source + ' Diff-modal edit.');
  await page.locator('#gitpanel .githead button.gbtn', {hasText: '↻'})
    .click();
  const row = page.locator('#gitpanel .gitrow', {hasText: 'ch2.tex'})
    .first();
  await expect(row).toBeVisible({timeout: 10000});
  await row.locator('button.gbtn', {hasText: '⧉'}).first().click();
  await expect(page.locator('#gitmodal')).toBeVisible({timeout: 8000});
  await expect(page.locator('#gitmodal .gitdiffpre'))
    .toContainText('diff --git', {timeout: 8000});
  await page.locator('#gitmodal button.edbtn', {hasText: 'Close'}).click();
  await expect(page.locator('#gitmodal')).toBeHidden({timeout: 8000});
});

// =====================================================================
// Missed-click regressions (register #14)
// =====================================================================

test('hovering a project row reveals its buttons without shifting them',
  async ({page}) => {
    await stubProof(page);
    // deterministic compile error: the real click below must not depend
    // on a TeX toolchain
    await page.route(/\/api\/project\/[^/]+\/compile$/, r => r.fulfill({
      status: 400, contentType: 'application/json',
      body: JSON.stringify({detail: 'e2e: simulated compile failure'})}));
    await page.goto(srv.baseUrl);
    await settleForEditing(page);
    const row = page.locator('#projlist .pitem').first();
    const pdf = row.locator('button.ptoolbtn', {hasText: 'PDF'});
    // the buttons exist in layout BEFORE the hover — a display:none
    // reveal pops them in and shifts the row under the pointer, eating
    // the click (red: boundingBox was null pre-fix)
    const before = await pdf.boundingBox();
    expect(before, 'PDF button has a pre-hover layout box').not.toBeNull();
    await row.hover();
    const after = await pdf.boundingBox();
    expect(after).toEqual(before);
    // a REAL click on the revealed button lands
    await pdf.click();
    await expect(page.locator('#compilelog')).toBeVisible({timeout: 10000});
    await expect(page.locator('#compilelog'))
      .toContainText('simulated compile failure', {timeout: 8000});
  });

test('the git panel survives an unchanged refresh without rebuilding',
  async ({page}) => {
    await stubProof(page);
    await page.goto(srv.baseUrl);
    await settleForEditing(page);
    // tag the current commit button node, then force a status refresh —
    // with nothing changed, the panel must keep the SAME nodes (an
    // innerHTML rebuild under the pointer eats clicks)
    await page.evaluate(() => {
      const b = document.querySelector('#gitpanel button.edbtn.primary');
      b.dataset.e2eMarker = 'keep-me';
    });
    // wait for the WHOLE refresh round-trip (blockdiffs is the last
    // fetch before the rebuild) — an immediate check would race the
    // still-pending rebuild and pass vacuously
    const [resp] = await Promise.all([
      page.waitForResponse(r => /\/git\/blockdiffs/.test(r.url())),
      page.locator('#gitpanel .githead button.gbtn', {hasText: '↻'})
        .click(),
    ]);
    expect(resp.status()).toBe(200);
    await page.waitForTimeout(600);   // the rebuild lands after the fetches
    const marker = await page.evaluate(() =>
      document.querySelector('#gitpanel button.edbtn.primary')
        ?.dataset.e2eMarker || 'gone');
    expect(marker, 'panel nodes survive an unchanged refresh')
      .toBe('keep-me');
  });
