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
  // button is opacity:0 until the line is hovered. [1]: following-sibling
  // selects ALL later siblings — take the first.
  const after = page.locator('.block.b-paragraph',
    {hasText: 'The editor understands sectioning'});
  const line = after.locator(
    'xpath=following-sibling::div[contains(@class,"insertline")][1]');
  await line.hover();
  // dispatchEvent: a real click opens the menu UNDER the cursor, which
  // then covers the button and breaks the click's own mouseup
  await line.locator('span.insertbtn').dispatchEvent('click');
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
    const para = doc.blocks.find(b => b.file === 'chapters/ch1.tex' &&
      b.type === 'paragraph' && b.source.includes('Align environments'));
    await apiSaveBlock(srv, para.id,
      'Proofreading finds mispelled words in this paragraph.');
    // the save went through the API — the client doc is stale until the
    // watcher's WS reload lands; the check maps flagged offsets onto the
    // client doc, so it must catch up first
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
