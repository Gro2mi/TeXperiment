/* TeXperiment — frontend (vanilla JS, no build step). */
'use strict';

/* ------------------------------------------------------------------ */
/* state + tiny helpers                                                */
/* ------------------------------------------------------------------ */

const state = {
  projects: [],
  project: null,     // current project id
  doc: null,
  ws: null,
  edit: null,        // {id, kind, original, root, block}
  browsePath: null,  // disk browser location
  collapsed: new Set(), // section block ids hidden via their chevron
  git: null,         // last /git/status payload (null = not fetched yet)
  gitChanged: new Set(), // block ids whose content differs from git HEAD
  gitHl: true,       // highlight changed blocks in the document
  gitShowDiff: false, // show only changed blocks
  proof: {           // proofreading state
    config: null,    // /proof/config payload (engine availability)
    issues: [],
    checking: false,
    checked: false,
  },
  history: {can_undo: false, can_redo: false}, // server-side undo/redo flags
  bib: null,         // parsed .bbl: {style, entries} — null = not loaded
  gitDiff: {diffs: {}, ghosts: []}, // word-level diffs vs git HEAD
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.remove('hidden');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.add('hidden'), 3500);
}

function banner(msg) {
  const b = $('#banner');
  if (!msg) { b.classList.add('hidden'); b.innerHTML = ''; return; }
  b.innerHTML = '';
  b.append(el('span', '', esc(msg)));
  const btn = el('button', 'edbtn', 'Reload from disk');
  btn.onclick = () => { b.classList.add('hidden'); refreshDoc(); };
  b.append(btn);
  b.classList.remove('hidden');
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail || detail; } catch (e) { /* noop */ }
    const err = new Error(detail);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

const post = (path, body) => api(path, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(body),
});

// per-project API prefix
const P = () => `/api/project/${state.project}`;
const papi = (path, opts) => api(P() + path, opts);
const ppost = (path, body) => papi(path, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(body),
});

/* ------------------------------------------------------------------ */
/* LaTeX inline renderer (paragraph text → HTML)                       */
/* ------------------------------------------------------------------ */

const INLINE_ARG_CMDS = ['textbf', 'textit', 'emph', 'underline', 'texttt',
  'text', 'textrm', 'mbox', 'footnote', 'ref', 'eqref', 'label', 'url'];
// natbib & friends: rendered as one chip including optional args and keys
const CITE_CMDS = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt',
  'citeauthor', 'citeyear', 'citeyearpar', 'Citep', 'Citet', 'citeonline']);
// run-in headings rendered as bold lead-ins
const RUNIN_CMDS = new Set(['paragraph', 'subparagraph']);
const SI_SIMPLE = new Set(['si', 'num', 'ang']);

const UNIT_MACROS = {kilo: 'k', centi: 'c', milli: 'm', micro: 'µ', nano: 'n',
  metre: 'm', meter: 'm', gram: 'g', second: 's', kelvin: 'K', mole: 'mol',
  hour: 'h', day: 'd', percent: '%', degree: '°', metrePerSecond: 'm/s'};

function renderUnit(u) {
  let s = u.replace(/\\squared\b/g, '²').replace(/\\cubic\b/g, '³')
           .replace(/\\per\b/g, '/');
  s = s.replace(/\\([a-zA-Z]+)/g, (m, name) => UNIT_MACROS[name] ?? name);
  return s.replace(/\\[,;:! ]/g, '\u2009').trim();
}

function readGroups(src, from, count) {
  // read `count` brace groups, skipping horizontal whitespace between them
  const groups = [];
  let j = from;
  for (let k = 0; k < count; k++) {
    while (j < src.length && ' \t'.includes(src[j])) j++;
    const g = readGroup(src, j);
    if (!g) return null;
    groups.push(g.body);
    j = g.end;
  }
  return {groups, end: j};
}

// siunitx-style grouping: thin space every 3 digits, only from 4 digits up
// (mirrors \sisetup{group-minimum-digits=4}); decimal parts stay untouched
function groupDigits(s) {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(s.trim());
  if (!m || m[2].length < 4) return s;
  return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009') + (m[3] || '');
}
const SPACING_CMDS = new Set(['', 'par', 'newline', 'noindent', 'quad', 'qquad',
  'big', 'Big', 'bigl', 'Bigl', 'left', 'right', 'centering', 'small', 'large',
  'normalsize', 'hfill', 'vspace', 'hspace', 'clearpage', 'newpage']);

function findUnescaped(s, from, ch) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === ch) return i;
  }
  return -1;
}

function readGroup(s, pos) {
  let i = pos;
  while (i < s.length && ' \t\r\n'.includes(s[i])) i++;
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') depth++;
    else if (s[j] === '}') {
      depth--;
      if (!depth) return {body: s.slice(i + 1, j), bodyStart: i + 1, end: j + 1};
    }
  }
  return null;
}

function katexSpan(tex, display) {
  if (typeof katex === 'undefined') return `<code class="kerr">${esc(tex)}</code>`;
  try {
    return katex.renderToString(tex,
      {displayMode: display, throwOnError: true, output: 'html'});
  } catch (e) {
    try {
      return katex.renderToString(tex,
        {displayMode: display, throwOnError: false, output: 'html'});
    } catch (e2) {
      return `<code class="kerr">${esc(tex)}</code>`;
    }
  }
}

// proof marks [s,e) in a block's source — the squiggle spans for rendering
function proofMarksFor(b) {
  if (!state.proof || !state.proof.issues.length) return [];
  return state.proof.issues.filter(i => i.block_id === b.id)
    .map(i => [i.start, i.end]).sort((a, c) => a[0] - c[0]);
}

// shift marks from block-source coordinates into a sub-string that starts
// at srcOffset and has length len (used for titles, list items, captions)
// shift git diff annotations into a sub-string starting at srcOffset
function shiftGit(git, srcOffset, len) {
  if (!git) return null;
  const adds = git.adds
    .filter(m => m.e > srcOffset && m.s < srcOffset + len)
    .map(m => ({s: Math.max(0, m.s - srcOffset), e: Math.min(len, m.e - srcOffset)}));
  const dels = git.dels
    .filter(d => d.s >= srcOffset && d.s < srcOffset + len)
    .map(d => ({s: d.s - srcOffset, text: d.text}));
  return (adds.length || dels.length) ? {adds, dels} : null;
}

// word-level diff annotations for a block (null = no inline detail)
function gitMarksFor(b) {
  if (!state.gitHl || !state.gitDiff || !state.gitDiff.diffs) return null;
  const d = state.gitDiff.diffs[b.id];
  if (!d) return null;
  if (d.kind === 'new') return {adds: [{s: 0, e: b.source.length}], dels: []};
  return d;
}

function shiftMarks(marks, srcOffset, len) {
  if (!marks || !marks.length) return [];
  return marks
    .filter(m => m[1] > srcOffset && m[0] < srcOffset + len)
    .map(m => [Math.max(0, m[0] - srcOffset), Math.min(len, m[1] - srcOffset)]);
}

// resolved citation display from the parsed .bbl — shows what LaTeX typesets.
// Returns null when the bibliography is unknown or a key is missing, so the
// caller falls back to the raw-source chip
function renderCitation(cmd, opts, keys) {
  const bib = state.bib;
  if (!bib || !bib.available || !keys.length) return null;
  const byKey = new Map(bib.entries.map(e => [e.key, e]));
  const es = keys.map(k => byKey.get(k));
  if (es.some(e => !e)) return null;
  const low = cmd.toLowerCase();
  const kind = (low.replace(/^cite/, '').replace(/\*$/, '') || 'p');
  const wrap = s => `<span class="citeref" data-keys="${esc(keys.join(','))}">${s}</span>`;
  let html;
  if (bib.style === 'numeric') {
    const nums = es.map(e => String(e.num)).join(', ');
    if (kind === 'year') html = esc(nums);
    else if (kind === 'yearpar') html = '(' + esc(nums) + ')';
    else {
      html = (opts[0] ? esc(opts[0]) + ' ' : '') + '[' + esc(nums) + ']' +
        (opts[1] ? ' ' + esc(opts[1]) : '');
    }
  } else {
    const ap = es.map(e => ({
      a: esc(e.authors || '?'), y: esc(e.year || 'n.d.'),
    }));
    if (kind === 'year') html = ap.map(x => x.y).join(', ');
    else if (kind === 'yearpar') html = '(' + ap.map(x => x.y).join(', ') + ')';
    else if (kind === 'author') html = ap.map(x => x.a).join('; ');
    else if (kind === 'alp' || kind === 'alt') {
      html = ap.map(x => x.a + ' ' + x.y).join('; ');
    } else if (kind === 't') {
      html = ap.map(x => x.a + ' (' + x.y + ')').join('; ');
      if (opts[0]) html = esc(opts[0]) + ' ' + html;
      if (opts[1]) html += ' ' + esc(opts[1]);
    } else { // citep, cite, citeonline
      const inner = ap.map(x => x.a + ', ' + x.y).join('; ');
      html = '(' + (opts[0] ? esc(opts[0]) + ' ' : '') + inner +
        (opts[1] ? ', ' + esc(opts[1]) : '') + ')';
    }
    if (cmd[0] === 'C') html = html.charAt(0).toUpperCase() + html.slice(1);
  }
  return wrap(html);
}

function renderInline(src, marks, git) {
  marks = marks || [];
  const adds = git && git.adds ? git.adds : [];
  const dels = git && git.dels ? git.dels : [];
  let di = 0, ai = 0;
  const flushDels = () => {
    while (di < dels.length && dels[di].s <= i) {
      const d = dels[di++];
      const full = d.text.replace(/\\s+/g, ' ').trim();
      const shown = full.length > 60 ? full.slice(0, 60) + '…' : full;
      out += `<span class="git-del" data-full="${esc(full).replace(/"/g, '&quot;')}">${esc(shown)}</span>`;
    }
  };
  marks = marks || [];
  let mi = 0;
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    // new text first: a green add-run at this position renders before
    // the crossed-out old text that follows it
        // wrap runs inside a git add-range in green
        if (adds.length) {
          while (ai < adds.length && i >= adds[ai].e) ai++;
          const ga = adds[ai];
          if (ga && i >= ga.s && i < ga.e) {
            let run = '';
            while (i < n && i < ga.e) {
              const ch = src[i];
              if (ch === '\\' || ch === '$' || ch === '%') break;
              run += (ch === '\n' || ch === '~') ? ' ' : ch;
              i++;
            }
            if (run) {
              out += `<span class="git-add">${esc(run)}</span>`;
              continue;
            }
            // run starts on a command/math char - fall through so the
            // normal branches advance past it (never loop without progress)
          }
        }
    flushDels();
    const c = src[i];
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+)\*?/.exec(src.slice(i));
      if (!m) { // escaped char like \% \& \$ \_ \#
        if (i + 1 < n) { out += esc(src[i + 1]); i += 2; }
        else { out += esc(c); i++; }
        continue;
      }
      const cmd = m[1];
      const after = i + m[0].length;
      if (CITE_CMDS.has(cmd)) {
        // \citep[opts]{keys} — whole call becomes one chip
        let j = after;
        const opts = [];
        for (;;) {
          while (j < n && ' \t\r\n'.includes(src[j])) j++;
          if (src[j] === '[') {
            const close = findUnescaped(src, j + 1, ']');
            if (close > 0) { opts.push(src.slice(j + 1, close)); j = close + 1; continue; }
          }
          break;
        }
        const g = readGroup(src, j);
        if (g) {
          const keys = g.body.split(',').map(s => s.trim()).filter(Boolean);
          const resolved = renderCitation(cmd, opts, keys);
          if (resolved !== null) {
            out += resolved;
            i = g.end;
            continue;
          }
          const optStr = opts.length ? '[' + opts.join('][') + ']' : '';
          out += `<span class="chip">${esc(cmd)}${esc(optStr)}{${esc(g.body)}}</span>`;
          i = g.end;
          continue;
        }
      }
      if (INLINE_ARG_CMDS.includes(cmd)) {
        const g = readGroup(src, after);
        if (g) {
          if (cmd === 'footnote') {
            out += `<sup class="fn" title="footnote">${renderInline(g.body, shiftMarks(marks, g.bodyStart, g.body.length), shiftGit(git, g.bodyStart, g.body.length))}</sup>`;
          } else if (['ref', 'eqref', 'cite', 'label'].includes(cmd)) {
            out += `<span class="chip">${cmd}:${esc(g.body)}</span>`;
          } else if (cmd === 'url') {
            out += `<code>${esc(g.body)}</code>`;
          } else if (cmd === 'textbf') {
            out += `<strong>${renderInline(g.body, shiftMarks(marks, g.bodyStart, g.body.length), shiftGit(git, g.bodyStart, g.body.length))}</strong>`;
          } else if (cmd === 'texttt') {
            out += `<code>${esc(g.body)}</code>`;
          } else if (cmd === 'underline') {
            out += `<u>${renderInline(g.body, shiftMarks(marks, g.bodyStart, g.body.length), shiftGit(git, g.bodyStart, g.body.length))}</u>`;
          } else { // textit, emph, text, textrm, mbox
            out += `<em>${renderInline(g.body, shiftMarks(marks, g.bodyStart, g.body.length), shiftGit(git, g.bodyStart, g.body.length))}</em>`;
          }
          i = g.end;
          continue;
        }
      }
      if (cmd === 'item') { i = after; continue; }
      if (SPACING_CMDS.has(cmd)) {
        out += (cmd === 'quad' || cmd === 'qquad') ? '&nbsp;&nbsp;'
          : (cmd === 'newline' ? '<br>' : ' ');
        i = after;
        const g = readGroup(src, after); // consume arg of vspace/hspace
        if (g && ['vspace', 'hspace'].includes(cmd)) i = g.end;
        continue;
      }
      if (RUNIN_CMDS.has(cmd)) {
        // \paragraph{Title.} → bold run-in heading followed by the text
        const g = readGroup(src, after);
        if (g) {
          out += `<strong>${renderInline(g.body, shiftMarks(marks, g.bodyStart, g.body.length), shiftGit(git, g.bodyStart, g.body.length))}</strong> `;
          i = g.end;
          continue;
        }
      }
      if (cmd === 'SI' || cmd === 'qty' || SI_SIMPLE.has(cmd)) {
        const n = SI_SIMPLE.has(cmd) ? 1 : 2;
        const r = readGroups(src, after, n);
        if (r) {
          let val;
          if (cmd === 'si') val = renderUnit(r.groups[0]);
          else if (cmd === 'num') val = groupDigits(r.groups[0]);
          else if (cmd === 'ang') val = r.groups[0].trim() + '°';
          else val = `${groupDigits(r.groups[0])}\u2009${renderUnit(r.groups[1])}`;
          out += esc(val);
          i = r.end;
          continue;
        }
      }
      if (cmd === 'SIrange' || cmd === 'numrange' || cmd === 'qtyrange') {
        const r = readGroups(src, after, 3);
        if (r) {
          const joiner = cmd === 'SIrange' ? ' to ' : '–';
          out += esc(`${groupDigits(r.groups[0])}${joiner}${groupDigits(r.groups[1])}`) +
            (r.groups[2].trim() ? `\u2009${esc(renderUnit(r.groups[2]))}` : '');
          i = r.end;
          continue;
        }
      }
      // unknown command: pull in the following [..]/{..} arguments so the
      // whole call is one chip, e.g. \paragraph{Terrain parameters.}
      let j = after;
      const parts = [];
      for (;;) {
        while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
        if (src[j] === '[') {
          const close = findUnescaped(src, j + 1, ']');
          if (close > 0) { parts.push(`[${src.slice(j + 1, close)}]`); j = close + 1; continue; }
          break;
        }
        if (src[j] === '{') {
          const g = readGroup(src, j);
          if (g) { parts.push(`{${g.body}}`); j = g.end; continue; }
        }
        break;
      }
      out += `<span class="chip">\\${esc(cmd)}${esc(parts.join(''))}</span>`;
      i = j;
    } else if (c === '$') {
      if (src[i + 1] === '$') { i += 2; continue; } // display math is block-level
      const j = findUnescaped(src, i + 1, '$');
      if (j > 0) { out += katexSpan(src.slice(i + 1, j), false); i = j + 1; }
      else { out += esc(c); i++; }
    } else if (c === '%' && (i === 0 || src[i - 1] !== '\\')) {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      out += `<span class="icomment">${esc(src.slice(i, j))}</span>`;
      i = j;
    } else if (c === '\n' || c === '~') {
      out += ' '; i++;
    } else if (c === '&') {
      out += '<span class="chip">&amp;</span>'; i++;
    } else {
      // plain character — wrap runs inside a proof mark in a squiggle
      if (marks.length) {
        while (mi < marks.length && i >= marks[mi][1]) mi++;
        const mk = marks[mi];
        if (mk && i >= mk[0] && i < mk[1]) {
          let run = '';
          while (i < n && i < mk[1] && src[i] !== '\\' && src[i] !== '$' &&
                 src[i] !== '%') {
            run += (src[i] === '\n' || src[i] === '~') ? ' ' : src[i];
            i++;
          }
          out += `<span class="pf-err">${esc(run)}</span>`;
          continue;
        }
      }
      out += esc(c); i++;
    }
  }
    flushDels(); // trailing deletions after an add that reached the end
  return out;
}

/* ------------------------------------------------------------------ */
/* math / table / figure source helpers                                */
/* ------------------------------------------------------------------ */

const MATH_WRAP_ENV_RE = /^\s*\\begin\{([A-Za-z]+\*?)\}(?:\[[^\]]*\])?([\s\S]*)\\end\{[A-Za-z]+\*?\}\s*$/;

function mathInner(b) {
  const wrap = (b.meta && b.meta.wrap) || 'dollars';
  if (wrap === 'dollars' || wrap === 'brackets') {
    return b.source.slice(2, b.source.length - 2).trim();
  }
  const m = MATH_WRAP_ENV_RE.exec(b.source);
  return m ? m[2].trim() : b.source;
}

function mathWrap(wrap, latex) {
  if (wrap === 'dollars') return `$$\n${latex}\n$$`;
  if (wrap === 'brackets') return `\\[\n${latex}\n\\]`;
  if (wrap.startsWith('env:')) {
    const name = wrap.slice(4);
    return `\\begin{${name}}\n${latex}\n\\end{${name}}`;
  }
  return latex;
}

// multi-line math environments that KaTeX needs wrapped in an amsmath
// sub-environment so bare & alignment and \\ row separators parse
const ALIGNED_ENVS = new Set(['align', 'align*', 'eqnarray', 'eqnarray*']);
const GATHERED_ENVS = new Set(['gather', 'gather*']);

function displayTex(b) {
  // \label is not KaTeX-supported — stripped here, shown as a chip instead
  const inner = mathInner(b).replace(/\\label\{[^}]*\}/g, '').trim();
  const wrap = (b.meta && b.meta.wrap) || 'dollars';
  if (wrap.startsWith('env:')) {
    const name = wrap.slice(4);
    if (ALIGNED_ENVS.has(name)) return `\\begin{aligned}${inner}\\end{aligned}`;
    if (GATHERED_ENVS.has(name)) return `\\begin{gathered}${inner}\\end{gathered}`;
  }
  return inner;
}

function mathLabels(src) {
  return [...src.matchAll(/\\label\{([^}]*)\}/g)].map(m => m[1].trim());
}

function labelChips(labels) {
  return labels.map(l => `<span class="chip">label:${esc(l)}</span>`).join(' ');
}

/* ------------------------------------------------------------------ */
/* rich table model: parse/serialize real tables (wrapper, booktabs,   */
/* tabularx, captions) so the grid editor can open them                */
/* ------------------------------------------------------------------ */

const TABLE_RULE_CMDS = new Set(['toprule', 'midrule', 'bottomrule',
  'hline', 'cline', 'cmidrule']);

// end index just past the balanced {...} group starting at s[i] == '{'
function groupEndAt(s, i) {
  let d = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (!d) return k + 1; }
  }
  return -1;
}

// scan a tabular body into cells / rules / row ends — escape-aware, so
// `\&` stays in its cell and `\\[1ex]` spacing never leaks into cells
function tokenizeTableBody(body) {
  const toks = [];
  let cur = '';
  const pushCell = () => { toks.push({t: 'cell', text: cur}); cur = ''; };
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\') {
      if (body[i + 1] === '\\') {
        pushCell();
        let spacing = '';
        const sm = /^\[[^\]]*\]/.exec(body.slice(i + 2));
        if (sm) { spacing = sm[0]; i += sm[0].length; }
        toks.push({t: 'rowend', spacing});
        i += 2;
        continue;
      }
      const m = /^\\([a-zA-Z]+)\*?/.exec(body.slice(i));
      if (!m) { cur += body.slice(i, i + 2); i += 2; continue; }
      const cmd = m[1];
      if (TABLE_RULE_CMDS.has(cmd)) {
        pushCell();
        // consume the rule's [..]/{..} arguments verbatim (cline{2-3},
        // cmidrule(lr){2-3})
        let j = i + m[0].length;
        let arg = '';
        for (;;) {
          const ws = /^[ \t]*/.exec(body.slice(j));
          j += ws[0].length;
          if (body[j] === '[') {
            const e = body.indexOf(']', j);
            if (e < 0) break;
            arg += ws[0] + body.slice(j, e + 1); j = e + 1; continue;
          }
          if (body[j] === '{') {
            const g = groupEndAt(body, j);
            if (g < 0) break;
            arg += ws[0] + body.slice(j, g); j = g; continue;
          }
          break;
        }
        toks.push({t: 'rule', kind: cmd, arg});
        i = j;
        continue;
      }
      cur += m[0]; i += m[0].length;
      continue;
    }
    if (c === '&') { pushCell(); toks.push({t: 'sep'}); i++; continue; }
    cur += c; i++;
  }
  if (cur.trim() || !toks.length) pushCell();
  return toks;
}

const MC_RE = /^\\multicolumn\{(\d+)\}\{([^{}]*)\}\{([\s\S]*)\}$/;

// fold body tokens into rows + boundary rules (`before` = index of the
// row the rule precedes, 0..rows.length); multicolumn cells become
// span-annotated, exotic constructs set the advanced flag
function tableBodyToModel(body) {
  const rows = [];
  const rules = [];
  let cells = [];
  let spacing = '';
  let advanced = false;
  // a lone whitespace-only cell pending before a rule/row end is an
  // inter-token artifact (e.g. the newline after \toprule), not a cell
  const dropArtifact = () => {
    if (cells.length === 1 && !cells[0].text && !cells[0].mc) cells = [];
  };
  const flushRow = () => {
    dropArtifact();
    if (!cells.length) return;
    rows.push({cells, spacing});
    cells = [];
  };
  for (const tk of tokenizeTableBody(body)) {
    if (tk.t === 'cell') {
      const text = tk.text.trim();
      const mc = MC_RE.exec(text);
      if (mc) {
        cells.push({text: mc[3].trim(), mc: {n: +mc[1], spec: mc[2]}});
      } else {
        if (/\\multirow|\\cline/.test(text)) advanced = true;
        cells.push({text, mc: null});
      }
    } else if (tk.t === 'rowend') {
      spacing = tk.spacing;
      flushRow();
    } else if (tk.t === 'rule') {
      dropArtifact();
      if (tk.kind === 'cline' || tk.kind === 'cmidrule') advanced = true;
      // a rule binds to the boundary after the row currently being built
      // (rows.length + 1 once it flushes), or the next row when none is
      rules.push({before: rows.length + (cells.length ? 1 : 0),
        kind: tk.kind, arg: tk.arg});
    }
  }
  flushRow();
  for (const r of rules) {
    if (r.before > rows.length) r.before = rows.length;
  }
  return {rows, rules, advanced};
}

// parse a full table block source into the rich model, or null
function parseTableRich(src) {
  const s = src.trim();
  let wrap = null;
  let inner = s;
  const wm = /^\\begin\{(table\*?)\}(\[[^\]]*\])?/.exec(s);
  if (wm) {
    const endTag = '\\end{' + wm[1] + '}';
    const endI = s.lastIndexOf(endTag);
    if (endI < 0) return null;
    if (s.slice(endI + endTag.length).trim()) return null;
    wrap = {env: wm[1], pos: wm[2] || '', pre: '', post: ''};
    inner = s.slice(wm[0].length, endI);
  }
  const tm = /\\begin\{(tabularx|tabular\*?|longtable)\*?\}/.exec(inner);
  if (!tm) return null;
  const tabEnv = tm[1];
  let i = tm.index + tm[0].length;
  const skipWs = () => { while (i < inner.length && inner[i] === ' ') i++; };
  skipWs();
  if (inner[i] === '[') {
    const e = inner.indexOf(']', i);
    if (e < 0) return null;
    i = e + 1; skipWs();
  }
  let widthArg = null;
  if (/^(tabularx|tabular\*)$/.test(tabEnv)) {
    if (inner[i] !== '{') return null;
    const g = groupEndAt(inner, i);
    if (g < 0) return null;
    widthArg = inner.slice(i + 1, g - 1);
    i = g; skipWs();
    if (inner[i] === '[') {
      const e = inner.indexOf(']', i);
      if (e < 0) return null;
      i = e + 1; skipWs();
    }
  }
  if (inner[i] !== '{') return null;
  const cg = groupEndAt(inner, i);
  if (cg < 0) return null;
  const colspec = inner.slice(i + 1, cg - 1);
  const endTag = '\\end{' + tabEnv + '}';
  const envEnd = inner.indexOf(endTag, cg);
  if (envEnd < 0) return null;
  const body = inner.slice(cg, envEnd);
  const beforeTab = inner.slice(0, tm.index);
  const afterTab = inner.slice(envEnd + endTag.length);

  const {rows, rules, advanced} = tableBodyToModel(body);
  if (!rows.length) return null;

  // caption/label sit outside the tabular env; everything else in the
  // wrapper is preserved verbatim (centering, size commands, vspace)
  let caption = null;
  let label = null;
  const splitMeta = (chunk, pos) => {
    let out = chunk;
    const lm = /\\label\{([^{}]*)\}/.exec(out);
    if (lm) {
      label = lm[1];
      out = out.slice(0, lm.index) + out.slice(lm.index + lm[0].length);
    }
    const cm = /\\caption(\[[^\]]*\])?\{/.exec(out);
    if (cm) {
      const g = readGroup(out, cm.index + cm[0].length - 1);
      if (g) {
        caption = {text: g.body, short: cm[1] || null, pos};
        out = out.slice(0, cm.index) + out.slice(g.end);
      }
    }
    return out;
  };
  const preChunk = splitMeta(beforeTab, 'above');
  const postChunk = splitMeta(afterTab, 'below');
  if (wrap) {
    wrap.pre = preChunk.trim();
    wrap.post = postChunk.trim();
  } else if (preChunk.trim() || postChunk.trim()) {
    return null; // stray text around a bare tabular → source editor
  }
  return {wrap, tabEnv, widthArg, colspec, rows, rules, caption, label,
    advanced};
}

function serializeTableRich(m) {
  const L = [];
  const pushMeta = () => {
    if (m.caption) L.push('\\caption' + (m.caption.short || '') +
      '{' + m.caption.text + '}');
    if (m.label) L.push('\\label{' + m.label + '}');
  };
  if (m.wrap) L.push('\\begin{' + m.wrap.env + '}' + m.wrap.pos);
  if (m.wrap && m.wrap.pre) L.push(m.wrap.pre);
  if (m.caption && m.caption.pos === 'above') pushMeta();
  L.push('\\begin{' + m.tabEnv + '}' +
    (m.widthArg ? '{' + m.widthArg + '}' : '') + '{' + m.colspec + '}');
  const rulesAt = before => (m.rules || [])
    .filter(r => r.before === before)
    .map(r => '\\' + r.kind + (r.arg || ''));
  const head = rulesAt(0);
  if (head.length) L.push(head.join(' '));
  m.rows.forEach((row, i) => {
    const cells = row.cells.map(c => c.mc
      ? `\\multicolumn{${c.mc.n}}{${c.mc.spec}}{${c.text}}`
      : c.text);
    L.push(cells.join(' & ') + ' \\\\' + (row.spacing || ''));
    const rl = rulesAt(i + 1);
    if (rl.length) L.push(rl.join(' '));
  });
  L.push('\\end{' + m.tabEnv + '}');
  if (m.caption && m.caption.pos === 'below') pushMeta();
  if (m.wrap && m.wrap.post) L.push(m.wrap.post);
  if (m.wrap) L.push('\\end{' + m.wrap.env + '}');
  return L.join('\n');
}

function parseTabular(src) {
  const bm = /\\begin\{(tabular\*?)\}/.exec(src);
  if (!bm) return null;
  const envEnd = src.lastIndexOf('\\end{' + bm[1] + '}');
  if (envEnd < 0) return null;
  const pre = src.slice(0, bm.index);
  const post = src.slice(envEnd + bm[1].length + 7);
  if (pre.trim() || post.trim()) return null; // caption/wrapper text → source editor

  let i = bm.index + bm[0].length;
  while (i < src.length && src[i] === ' ') i++;
  if (src[i] === '[') {
    const j = src.indexOf(']', i);
    if (j < 0) return null;
    i = j + 1;
    while (i < src.length && src[i] === ' ') i++;
  }
  if (src[i] !== '{') return null;
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  if (depth) return null;
  const colspec = src.slice(i + 1, j);
  const body = src.slice(j + 1, envEnd);
  if (/\\(multicolumn|multirow|hline|cline|cmidrule|vline|cellcolor|toprule|midrule|bottomrule)/.test(body)) return null;
  const rows = body.split(/\\\\/).map(r => r.trim()).filter(Boolean);
  if (!rows.length) return null;
  return {colspec, grid: rows.map(r => r.split('&').map(c => c.trim())), env: bm[1]};
}

// lenient parse for wrapped/rule-heavy tables (table env + tabularx +
// booktabs rules): finds the tabular anywhere, strips rules, renders cells.
// Used for display only — grid editing still requires the strict parse.
function parseTabularLenient(src) {
  const bm = /\\begin\{(tabularx?|longtable)\*?\}/.exec(src);
  if (!bm) return null;
  let i = bm.index + bm[0].length;
  while (i < src.length && src[i] === ' ') i++;
  if (src[i] === '[') {
    const j = src.indexOf(']', i);
    if (j < 0) return null;
    i = j + 1;
    while (i < src.length && src[i] === ' ') i++;
  }
  if (src[i] !== '{') return null;
  const readGroupAt = (pos) => {
    let d = 0, k = pos;
    for (; k < src.length; k++) {
      if (src[k] === '\\') { k++; continue; }
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (!d) return k + 1; }
    }
    return -1;
  };
  // tabularx / tabular* take a width argument BEFORE the column spec
  let end = readGroupAt(i);
  if (end < 0) return null;
  const first = src.slice(i + 1, end - 1);
  if (/^(tabularx|tabular\*)$/.test(bm[1])) {
    i = end;
    while (i < src.length && src[i] === ' ') i++;
    if (src[i] === '[') {
      const j = src.indexOf(']', i);
      if (j < 0) return null;
      i = j + 1;
      while (i < src.length && src[i] === ' ') i++;
    }
    if (src[i] !== '{') return null;
    end = readGroupAt(i);
    if (end < 0) return null;
  }
  const colspec = src.slice(i + 1, end - 1);
  const envEnd = src.indexOf('\\end{' + bm[1] + '}', end);
  if (envEnd < 0) return null;
  let body = src.slice(end, envEnd);
  body = body.replace(/\\(toprule|midrule|bottomrule|hline)\b/g, '')
             .replace(/\\cline\{[^}]*\}/g, '')
             .replace(/\\cmidrule(\([^)]*\))?(\[[^]]*\])?(\{[^}]*\})+/g, '');
  const rows = body.split(/\\\\/).map(r => r.trim()).filter(Boolean);
  if (!rows.length) return null;
  const grid = rows.map(r => r.split('&').map(c => {
    let cell = c.trim();
    const mc = /^\\multicolumn\{[^}]*\}\{[^}]*\}\{([\s\S]*)\}$/.exec(cell);
    if (mc) cell = mc[1].trim();
    return cell;
  }));
  let caption = '';
  const cm = /\\caption\{/.exec(src);
  if (cm) {
    const g = readGroup(src, cm.index + cm[0].length - 1);
    if (g) caption = g.body;
  }
  return {grid, caption, labels: mathLabels(src)};
}

function renderTableHTML(grid, marks, src, git) {
  // locate each cell's text sequentially in the block source so proof
  // squiggles (and the flash) work inside table cells too
  let cm = null;
  if (marks && marks.length && src) {
    const texts = grid.flat();
    const per = [];
    let cursor = 0;
    for (const t of texts) {
      let off = t ? src.indexOf(t, cursor) : -1;
      if (off < 0) off = t ? src.indexOf(t) : -1;
      if (off >= 0) cursor = off + t.length;
      per.push([off >= 0 ? shiftMarks(marks, off, t.length) : [],
            off >= 0 ? shiftGit(git, off, t.length) : null]);
    }
    cm = per;
  }
  let k = 0;
  const rows = grid.map(r =>
    `<tr>${r.map(c => { const pair = cm ? cm[k++] : [null, null];
      return `<td>${renderInline(c, pair[0], pair[1])}</td>`; }).join('')}</tr>`).join('');
  return `<table class="rtab">${rows}</table>`;
}

function figureParts(src) {
  const ig = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/.exec(src);
  let caption = '';
  const cm = /\\caption\{/.exec(src);
  if (cm) {
    const g = readGroup(src, cm.index + cm[0].length - 1);
    if (g) caption = g.body;
  }
  return {path: ig ? ig[1].trim() : null, caption};
}

function stripCommentDecorations(s) {
  return s.replace(/[-=]{3,}/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function listItems(src) {
  // strip the outer \begin{env}[..] and \end{env}, then split top-level \item
  let s = src.replace(/^\s*\\begin\{[A-Za-z]+\*?\}(?:\[[^\]]*\])?/, '');
  const endIdx = s.lastIndexOf('\\end{');
  if (endIdx >= 0) s = s.slice(0, endIdx);
  const items = [];
  let depth = 0, cur = '', i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const bm = /^\\begin\{([A-Za-z]+\*?)\}/.exec(rest);
    if (bm) { depth++; cur += bm[0]; i += bm[0].length; continue; }
    const em = /^\\end\{([A-Za-z]+\*?)\}/.exec(rest);
    if (em && depth > 0) { depth--; cur += em[0]; i += em[0].length; continue; }
    if (depth === 0 && /^\\item\b/.test(rest)) {
      items.push(cur); cur = '';
      i += 5;
      continue;
    }
    cur += s[i]; i++;
  }
  items.push(cur);
  return items.map(x => x.replace(/^[\s{*]+/, '')).filter(x => x.trim().length);
}

const EDITABLE = new Set(['paragraph', 'section', 'math', 'list', 'table',
  'figure', 'env', 'comment']);

// a comment whose display text is only % (after stripping -/= rules)
function isBlankComment(b) {
  return b.type === 'comment' &&
    stripCommentDecorations(b.source).replace(/%/g, '').trim() === '';
}

/* ------------------------------------------------------------------ */
/* block content renderers                                             */
/* ------------------------------------------------------------------ */

// a removed-since-HEAD block rendered as a red ghost placeholder row
function ghostEl(g) {
  const node = el('div', 'block git-ghost');
  node.dataset.ghost = g.gid;
  node.append(el('span', 'ghostbadge', 'removed'));
  const content = el('div', 'bcontent ghostcontent');
  const full = g.text.replace(/\\s+/g, ' ').trim();
  content.innerHTML = `<span class="git-del" data-full="${esc(full).replace(/"/g, '&quot;')}">${esc(full.length > 400 ? full.slice(0, 400) + '…' : full)}</span>`;
  node.append(content);
  return node;
}

function blockById(id) {
  return state.doc.blocks.find(b => b.id === id) || null;
}

function renderBlockContent(b) {
  switch (b.type) {
    case 'preamble': {
      const first = (b.source.match(/\\documentclass[^\n]*/) || [''])[0];
      return `<div><div>${esc(first)}</div>` +
        `<div style="color:#999;font-size:.85em">${b.source.split('\n').length} lines of document settings — edit via raw mode (sidebar)</div></div>`;
    }
    case 'enddoc':
      return esc(b.source.trim());
    case 'comment':
      // decorative -/= rules in comments are stripped for display only;
      // comments that end up empty (lone % separator lines) are not shown
      if (isBlankComment(b)) return '';
      return esc(stripCommentDecorations(b.source));
    case 'section': {
      const lv = Math.min((b.meta && b.meta.level) || 2, 4);
      const num = state.secNums ? state.secNums.get(b.id) : null;
      // titles may contain math: \section{Index ($\Omega_R$)}
      const collapsed = state.collapsed && state.collapsed.has(b.id);
      const chev = `<button class="collapsebtn" title="${collapsed ? 'Expand' : 'Collapse'} section">${collapsed ? '▸' : '▾'}</button>`;
      const title = (b.meta && b.meta.title) || '';
      // marks live in block-source coordinates; the title starts after '{'
      const titleMarks = shiftMarks(proofMarksFor(b), b.source.indexOf('{') + 1, title.length);
      const titleGit = shiftGit(gitMarksFor(b), b.source.indexOf('{') + 1, title.length);
      return `<h${lv} class="blk">${chev}${num ? num + ' ' : ''}${renderInline(title, titleMarks, titleGit)}</h${lv}>`;
    }
    case 'paragraph':
      return `<div class="rtext">${renderInline(b.source, proofMarksFor(b), gitMarksFor(b))}</div>`;
    case 'math': {
      const labels = mathLabels(b.source);
      return `<div class="disp-math">${katexSpan(displayTex(b), true)}` +
        (labels.length ? `<div class="mathlabels">${labelChips(labels)}</div>` : '') +
        `</div>`;
    }
    case 'list': {
      const isOrd = b.meta && b.meta.env === 'enumerate';
      const marks = proofMarksFor(b);
      let cursor = 0; // items appear in order — track each item's source offset
      const items = listItems(b.source).map(it => {
        let off = b.source.indexOf(it, cursor);
        if (off < 0) off = b.source.indexOf(it);
        if (off >= 0) cursor = off + it.length;
        const gm = off >= 0 ? shiftGit(gitMarksFor(b), off, it.length) : null; return `<li>${renderInline(it, off >= 0 ? shiftMarks(marks, off, it.length) : [], gm)}</li>`;
      });
      const tag = isOrd ? 'ol' : 'ul';
      return `<${tag} class="rtext">${items.join('')}</${tag}>`;
    }
    case 'table': {
      const t = parseTabular(b.source);
      if (t) return renderTableHTML(t.grid, proofMarksFor(b), b.source, gitMarksFor(b));
      const L = parseTabularLenient(b.source);
      if (L) {
        const cOff = L.caption ? b.source.indexOf(L.caption) : -1;
        const cMarks = cOff >= 0 ? shiftMarks(proofMarksFor(b), cOff, L.caption.length) : [];
        const cGit = cOff >= 0 ? shiftGit(gitMarksFor(b), cOff, L.caption.length) : null;
        return `<div class="tabwrap">` +
          renderTableHTML(L.grid, proofMarksFor(b), b.source, gitMarksFor(b)) +
          (L.caption ? `<figcaption class="figcap">${renderInline(L.caption, cMarks, cGit)}</figcaption>` : '') +
          (L.labels.length ? `<div class="mathlabels">${labelChips(L.labels)}</div>` : '') +
          `<div class="editnote">preview — edit as source for exact layout</div></div>`;
      }
      return `<div class="envcard">${esc(b.source)}</div>`;
    }
    case 'figure': {
      const {path, caption} = figureParts(b.source);
      if (!path) return `<div class="figerr">${esc(b.source)}</div>`;
      const img = `<img class="figimg" src="/files/${state.project}/${encodeURI(path)}" ` +
        `data-orig="${esc(path)}" alt="figure">`;
      const cOff = caption ? b.source.indexOf(caption) : -1;
      const cMarks = cOff >= 0 ? shiftMarks(proofMarksFor(b), cOff, caption.length) : [];
      const cGit = cOff >= 0 ? shiftGit(gitMarksFor(b), cOff, caption.length) : null;
      return `<figure class="blkfig">${img}` +
        (caption ? `<figcaption class="figcap">${renderInline(caption, cMarks, cGit)}</figcaption>` : '') +
        `</figure>`;
    }
    default:
      return `<div class="envcard">environment: <b>${esc((b.meta && b.meta.name) || '?')}</b>\n${esc(b.source)}</div>`;
  }
}

// image fallback: try common extensions before giving up
document.addEventListener('error', ev => {
  const img = ev.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.orig) return;
  if (!img.dataset.tried) img.dataset.tried = '0';
  const tries = ['', '.png', '.jpg', '.jpeg'];
  const n = +img.dataset.tried;
  if (n < tries.length) {
    img.dataset.tried = String(n + 1);
    img.src = `/files/${state.project}/` + encodeURI(img.dataset.orig + tries[n]);
  } else {
    img.replaceWith(el('div', 'figerr', '⚠ image not found: ' + esc(img.dataset.orig)));
  }
}, true);

/* ------------------------------------------------------------------ */
/* document rendering                                                  */
/* ------------------------------------------------------------------ */

function renderAll() {
  computeSectionNumbers();
  renderSidebar();
  renderContent();
  renderGit();
  renderProof();
}

// document-order section numbering (section → 1, subsection → 1.1, …)
function computeSectionNumbers() {
  state.secNums = new Map();
  if (!state.doc) return;
  const counters = [0, 0, 0, 0]; // chapter, section, subsection, subsubsection
  for (const b of state.doc.blocks) {
    if (b.type !== 'section') continue;
    const lv = Math.min((b.meta && b.meta.level) || 2, 4);
    counters[lv - 1]++;
    for (let i = lv; i < 4; i++) counters[i] = 0;
    state.secNums.set(b.id, counters.slice(1, lv).join('.'));
  }
}

function renderSidebar() {
  // projects as a list, most recently used first; compile/remove per row
  const pl = $('#projlist');
  pl.innerHTML = '';
  for (const p of state.projects) {
    const row = el('div', 'pitem' + (p.id === state.project ? ' current' : ''));
    row.title = p.main;
    const name = el('span', 'pname', esc(p.name));
    name.onclick = () => switchProject(p.id);
    const tools = el('span', 'ptools');
    const pdfBtn = el('button', 'ptoolbtn', 'PDF');
    pdfBtn.title = 'Compile this project and view the PDF';
    pdfBtn.onclick = ev => { ev.stopPropagation(); compileProject(p.id); };
    const delBtn = el('button', 'ptoolbtn danger', '✕');
    delBtn.title = 'Remove this project';
    delBtn.onclick = ev => { ev.stopPropagation(); removeProject(p.id); };
    tools.append(pdfBtn, delBtn);
    row.append(name, tools);
    pl.append(row);
  }

  const fl = $('#filelist');
  fl.innerHTML = '';
  const ol = $('#outline');
  ol.innerHTML = '';
  if (!state.doc) return;
  for (const f of state.doc.files) {
    const btn = el('button', 'fitem' + (f.path === state.doc.main ? ' main' : ''));
    btn.innerHTML = `<span class="fpath">${esc(f.path)}</span><span class="fraw">raw ✎</span>`;
    btn.querySelector('.fraw').onclick = ev => {
      ev.stopPropagation();
      openRaw(f.path);
    };
    btn.onclick = () => {
      const first = state.doc.blocks.find(b => b.file === f.path);
      if (first) scrollToBlock(first.id);
    };
    fl.append(btn);
  }
  // collapsible outline: build the section tree, hide entries whose
  // ancestors are folded
  if (!state.outlineCollapsed) state.outlineCollapsed = new Set();
  const secs = state.doc.blocks.filter(b => b.type === 'section');
  const entries = [];
  const stack = [];
  for (const b of secs) {
    const lv = (b.meta && b.meta.level) || 2;
    while (stack.length && stack[stack.length - 1].lv >= lv) stack.pop();
    entries.push({b, lv, parent: stack.length ? stack[stack.length - 1].id : null});
    stack.push({id: b.id, lv});
  }
  const byId = new Map(entries.map(e => [e.b.id, e]));
  const hasKids = new Set(entries.filter(e => e.parent).map(e => e.parent));
  const hiddenByFold = new Set();
  for (const e of entries) {
    let p = e.parent;
    while (p) {
      if (state.outlineCollapsed.has(p)) hiddenByFold.add(e.b.id);
      p = (byId.get(p) || {}).parent || null;
    }
  }
  for (const e of entries) {
    if (hiddenByFold.has(e.b.id)) continue;
    const item = el('button', 'oitem');
    item.style.setProperty('--indent', (e.lv - 1));
    item.dataset.block = e.b.id;
    const num = state.secNums.get(e.b.id);
    const collapsed = state.outlineCollapsed.has(e.b.id);
    const chev = hasKids.has(e.b.id)
      ? `<span class="ochev" data-oc="${e.b.id}" title="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▸' : '▾'}</span>`
      : '<span class="ochev noleaf"></span>';
    item.innerHTML = chev + (num ? num + '&nbsp;&nbsp;' : '') +
      renderInline(e.b.meta.title || '(untitled)');
    item.onclick = ev => {
      const chevEl = ev.target.closest('.ochev');
      if (chevEl && !chevEl.classList.contains('noleaf')) {
        state.outlineCollapsed.has(e.b.id)
          ? state.outlineCollapsed.delete(e.b.id)
          : state.outlineCollapsed.add(e.b.id);
        renderSidebar();
        return;
      }
      scrollToBlock(e.b.id);
    };
    ol.append(item);
  }
  updateOutlineCurrent();
  applyOutlineGitMarks();
}

// highlight the outline entry for the section currently on screen
function updateOutlineCurrent() {
  if (!state.doc) return;
  let currentId = null;
  for (const b of state.doc.blocks) {
    if (b.type !== 'section') continue;
    const node = document.querySelector(`.block[data-id="${b.id}"]`);
    if (!node) continue;
    if (node.getBoundingClientRect().top <= 140) currentId = b.id;
  }
  document.querySelectorAll('#outline .oitem').forEach(it =>
    it.classList.toggle('current', it.dataset.block === currentId));
}

function scrollToBlock(id) {
  const node = $(`.block[data-id="${id}"]`);
  if (node) node.scrollIntoView({behavior: 'smooth', block: 'start'});
}

/* ------------------------------------------------------------------ */
/* collapsible sections                                                */
/* ------------------------------------------------------------------ */

// ids of blocks hidden because they sit inside a collapsed section
function computeCollapsedIds(blocks) {
  const hidden = new Set();
  let hideLevel = null, rootId = null;
  for (const b of blocks) {
    if (b.type === 'section') {
      const lv = (b.meta && b.meta.level) || 2;
      if (hideLevel !== null && lv <= hideLevel) { hideLevel = null; rootId = null; }
      if (hideLevel === null && state.collapsed.has(b.id)) { hideLevel = lv; rootId = b.id; }
    }
    if (hideLevel !== null && b.id !== rootId) hidden.add(b.id);
  }
  return hidden;
}

function toggleCollapse(b) {
  state.collapsed.has(b.id) ? state.collapsed.delete(b.id) : state.collapsed.add(b.id);
  const content = $('#content');
  const node = document.querySelector(`.block[data-id="${b.id}"]`);
  const prevTop = node ? node.getBoundingClientRect().top : null;
  renderContent();
  const fresh = document.querySelector(`.block[data-id="${b.id}"]`);
  if (fresh && prevTop !== null) {
    content.scrollTop += fresh.getBoundingClientRect().top - prevTop;
  }
}

function renderContent() {
  closeOrphanAutocomplete(); // rebuilt editors leave no blur behind
  const c = $('#content');
  c.innerHTML = '';
  if (!state.doc) {
    c.append(el('div', 'emptystate',
      '<h2>No project open</h2><p>Click ＋ in the sidebar to open a main .tex file from disk.</p>'));
    return;
  }
  // diff-only mode: render just the blocks that differ from git HEAD
  const diffMode = state.gitShowDiff && state.git && state.git.repo;
  let blocks = state.doc.blocks;
  if (diffMode) blocks = blocks.filter(b => state.gitChanged.has(b.id));
  if (diffMode) {
    const bar = el('div', 'diffbar');
    bar.append(el('span', '', state.gitChanged.size
      ? `Diff view — ${state.gitChanged.size} changed block${state.gitChanged.size === 1 ? '' : 's'}`
      : 'Diff view — nothing differs from HEAD'));
    const exit = el('button', 'edbtn', 'Exit');
    exit.title = 'Back to the full document';
    exit.onclick = toggleDiffOnly;
    bar.append(el('span', 'spacer'), exit);
    c.append(bar);
    if (!blocks.length) {
      c.append(el('div', 'emptystate',
        '<h2>No changes</h2><p>Nothing differs from the last commit.</p>'));
      return;
    }
  }
  const hiddenIds = computeCollapsedIds(blocks);
  const docEl = el('div', 'doc');
  // git ghost rows: blocks removed since HEAD (only with highlighting on)
  const ghosts = (state.gitHl && state.git && state.git.repo
    && state.gitDiff && state.gitDiff.ghosts) ? state.gitDiff.ghosts : [];
  const pending = ghosts.slice();
  const flushGhosts = (beforeId) => {
    const out = [];
    for (let g = pending.length - 1; g >= 0; g--) {
      if (pending[g].before_id === beforeId) {
        out.unshift(ghostEl(pending.splice(g, 1)[0]));
      }
    }
    return out;
  };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const h = hiddenIds.has(b.id);
    docEl.append(blockEl(b, h));
    if (EDITABLE.has(b.type)) {
      // the insert line sits between two blocks: visible only if both are;
      // never between a heading and the \label{} that names it
      const next = i + 1 < blocks.length ? blocks[i + 1] : null;
      const headingLabel = b.type === 'section' && next &&
        next.source.trimStart().startsWith('\\label{');
      const nextH = i + 1 < blocks.length ? hiddenIds.has(blocks[i + 1].id) : h;
      if (!headingLabel) docEl.append(insertLine(b, h || nextH));
    }
  }
  for (const ge of (flushGhosts(null) || [])) docEl.append(ge);
  if (pending.length) pending.forEach(g => docEl.append(ghostEl(g))); // anchors hidden
  c.append(docEl);
}

function insertLine(b, hidden = false) {
  const line = el('div', 'insertline' + (hidden ? ' b-collapsed' : ''));
  line.title = 'Insert block here…';
  line.onclick = ev => { ev.stopPropagation(); showInsertMenu(b, ev); };
  line.append(el('span', 'insertbtn', '+'));
  return line;
}

function blockEl(b, hidden = false) {
  const node = el('div', 'block b-' + b.type + (hidden ? ' b-collapsed' : ''));
  node.dataset.id = b.id;
  if (state.diskKeys && state.diskKeys.has(blockKey(b))) node.classList.add('disk-change');
  if (state.gitHl && state.gitChanged.has(b.id)) node.classList.add('git-change');
  if (isBlankComment(b)) node.classList.add('b-hidden');
  node.append(el('div', 'bcontent', renderBlockContent(b)));
  node.append(buildTools(b));
  // grab handle on the left edge — mousedown starts a pointer-tracked drag
  const grip = el('div', 'grip', '⠿');
  grip.title = 'Drag to move this block';
  startBlockDrag(grip, node, b);
  node.append(grip);
  if (b.type === 'section') {
    // align the grip to the heading line, not the block's margin box
    requestAnimationFrame(() => {
      const heading = node.querySelector('.blk');
      if (!heading || !grip.isConnected) return;
      const hr = heading.getBoundingClientRect();
      const nr = node.getBoundingClientRect();
      grip.style.top = (hr.top - nr.top + hr.height / 2) + 'px';
    });
  }
  if (b.type === 'section') {
    // chevron toggles collapsing of everything in this section
    const collapsed = state.collapsed.has(b.id);
    node.addEventListener('click', ev => {
      if (ev.target.closest('.collapsebtn')) {
        ev.stopPropagation();
        toggleCollapse(b);
      }
    });
  }
  if (EDITABLE.has(b.type)) {
    // double-click edits; single click stays free for text marking
    node.addEventListener('dblclick', ev => {
      if (ev.target.closest('.editor') || ev.target.closest('.btools') ||
          ev.target.closest('.grip') || ev.target.closest('a')) return;
      openEditor(b);
    });
  }
  return node;
}

function buildTools(b) {
  const tools = el('div', 'btools');
  const mk = (label, title, fn, cls = '') => {
    const btn = el('button', cls, label);
    btn.title = title;
    btn.onclick = ev => { ev.stopPropagation(); fn(b); };
    return btn;
  };
  if (EDITABLE.has(b.type)) {
    tools.append(mk('✎', 'Edit block (or double-click)', openEditor));
  }
  tools.append(mk('↑', 'Move block up', bb => moveBlockFn(bb, 'up', 1)));
  tools.append(mk('↓', 'Move block down', bb => moveBlockFn(bb, 'down', 1)));
  if (EDITABLE.has(b.type)) {
    tools.append(mk('🗑', 'Delete block', deleteBlock, 'danger'));
  }
  return tools;
}

/* ------------------------------------------------------------------ */
/* drag & drop reordering — pointer events from the grip, tracked on   */
/* the whole document, so dropping works anywhere without moving right */
/* ------------------------------------------------------------------ */

function clearDropMarks() {
  document.querySelectorAll('.block.drop-before, .block.drop-after')
    .forEach(n => n.classList.remove('drop-before', 'drop-after'));
}

// nearest insertion slot for a pointer y (full window width works)
function findDropSlot(y) {
  const nodes = [...document.querySelectorAll('#content .block')];
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    if (y < r.top + r.height / 2) return {node: n, after: false};
  }
  const last = nodes[nodes.length - 1];
  return last ? {node: last, after: true} : null;
}

function startBlockDrag(grip, node, b) {
  grip.addEventListener('mousedown', ev => {
    if (ev.button !== 0 || state.dragActive) return;
    ev.preventDefault();
    ev.stopPropagation();
    const grabY = ev.clientY;
    state.dragActive = true;
    node.classList.add('dragging');
    document.body.classList.add('drag-active');

    const move = e => {
      const slot = findDropSlot(e.clientY);
      clearDropMarks();
      if (slot) slot.node.classList.add(slot.after ? 'drop-after' : 'drop-before');
    };
    const up = async e => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('drag-active');
      node.classList.remove('dragging');
      clearDropMarks();
      state.dragActive = false;
      const slot = findDropSlot(e.clientY);
      if (!slot) return;
      const src = blockById(b.id);
      const tgt = blockById(slot.node.dataset.id);
      if (!src || !tgt || src.id === tgt.id) return;
      if (src.file !== tgt.file) {
        toast('Blocks can only be reordered within the same file', true);
        return;
      }
      const same = state.doc.blocks.filter(x => x.file === src.file);
      const si = same.findIndex(x => x.id === src.id);
      const ti = same.findIndex(x => x.id === tgt.id);
      if (si < 0 || ti < 0) return;
      if (src.type === 'section') {
        // a heading drags its whole section: count sibling-section steps to
        // the section that owns the drop slot
        const level = x => x.type === 'section'
          ? ((x.meta && x.meta.level) || 2) : 99;
        const lv = level(src);
        let owner = -1;
        for (let k = ti; k >= 0; k--) {
          if (level(same[k]) <= lv) { owner = k; break; }
        }
        if (owner < 0) return;
        // dropped inside the section's own scope: treat the drag direction
        // (down/up vs. the grab point) as "move one sibling" — a natural
        // drag gesture should never be a silent no-op
        if (owner === si) {
          const d = e.clientY > grabY ? 'down' : 'up';
          const hasSib = same.some((x, k) => k !== si && level(x) <= lv &&
            (d === 'down' ? k > si : k < si));
          if (!hasSib) { toast('No neighboring section to move into'); return; }
          await moveBlockFn(src, d, 1);
          return;
        }
        const dir = ti > si ? 'down' : 'up';
        const sibs = same.map((x, k) => k)
          .filter(k => k !== si && level(same[k]) <= lv &&
            (dir === 'down' ? k > si : k < si));
        const positions = dir === 'down'
          ? sibs.filter(k => k <= owner).length
          : sibs.filter(k => k >= owner).length;
        if (positions < 1) return;
        await moveBlockFn(src, dir, positions);
        return;
      }
      const target = ti + (slot.after ? 1 : 0);
      if (target === si || target === si + 1) return; // dropped onto itself
      const direction = target > si ? 'down' : 'up';
      let positions = Math.abs(target - si);
      if (direction === 'down') positions -= 1;
      if (positions < 1) return;
      await moveBlockFn(src, direction, positions);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

/* ------------------------------------------------------------------ */
/* block operations                                                    */
/* ------------------------------------------------------------------ */

async function moveBlockFn(b, direction, positions) {
  try {
    const res = await ppost(`/block/${b.id}/move`, {direction, positions});
    applyDoc(res.doc);
  } catch (e) {
    if (e.status === 400) toast(e.message, true);
    else handleOpError(e, b);
  }
}

async function deleteBlock(b) {
  if (!confirm('Delete this block from ' + b.file + '?')) return;
  try {
    const res = await ppost(`/block/${b.id}/delete`, {});
    applyDoc(res.doc);
    toast('Block deleted');
  } catch (e) { handleOpError(e, b); }
}

function handleOpError(e, b) {
  if (e.status === 409 || e.status === 404) {
    banner(e.status === 409
      ? 'Conflict: the file changed on disk and this block could not be matched. Reload to see the current version.'
      : 'This block no longer exists — the document changed on disk. Reloading from disk…');
    if (b) markStale(b.id);
    if (e.status === 404) setTimeout(refreshDoc, 400);
    toast('Save failed: document changed on disk', true);
  } else {
    toast('Error: ' + e.message, true);
  }
}

function markStale(id) {
  const node = $(`.block[data-id="${id}"]`);
  if (node) node.classList.add('stale');
}

/* ------------------------------------------------------------------ */
/* editors                                                             */
/* ------------------------------------------------------------------ */

function rerenderBlock(b) {
  const old = $(`.block[data-id="${b.id}"]`);
  if (!old) return;
  const fresh = blockEl(b);
  if (old.classList.contains('stale')) fresh.classList.add('stale');
  old.replaceWith(fresh);
}

// MathLive's virtual keyboard is a separate layer — it stays open after the
// editor element is gone unless dismissed explicitly
function dismissMathKeyboard(rootEl) {
  const mf = rootEl && rootEl.querySelector ? rootEl.querySelector('math-field') : null;
  if (!mf) return;
  try { mf.blur(); } catch (e) { /* noop */ }
  try {
    const vk = window.mathVirtualKeyboard;
    if (vk && vk.visible) vk.hide();
  } catch (e) { /* noop */ }
  const content = $('#content');
  if (content) content.style.paddingBottom = '';
}

function closeEditor() {
  if (!state.edit) return;
  dismissMathKeyboard(state.edit.root.root);
  if (state._escHandler) {
    document.removeEventListener('keydown', state._escHandler, true);
    state._escHandler = null;
  }
  const b = blockById(state.edit.id);
  state.edit = null;
  if (b) rerenderBlock(b);
  closeOrphanAutocomplete(); // popups die with their editor (no blur event)
}

function openEditor(b) {
  if (state.edit) {
    if (state.edit.id === b.id) return;
    closeEditor();
  }
  const node = $(`.block[data-id="${b.id}"]`);
  if (!node) return;

  const kind = b.type === 'math' ? 'math'
    : (b.type === 'table' && parseTableRich(b.source) ? 'grid' : 'source');
  const ed = buildEditor(b, kind);
  node.classList.add('editing');
  node.querySelector('.bcontent').replaceWith(ed.root);
  state.edit = {id: b.id, kind, original: b.source, root: ed, block: b};
  // Esc always closes the open editor, whatever has focus — unless an
  // autocomplete popup is open, then Esc closes just the popup
  state._escHandler = ev => {
    if (ev.key === 'Escape') {
      if (document.querySelector('.acpopup')) return;
      ev.stopPropagation();
      ev.preventDefault();
      closeEditor();
    }
  };
  document.addEventListener('keydown', state._escHandler, true);
  ed.focus();
}

// soften lines longer than 120 chars: wrap at the last space before the
// limit; lines without a space (URLs, long math) are left untouched, and
// nothing is ever joined — comment lines are never broken (a bare \n would
// end the comment)
function reflowLongLines(src, limit = 120) {
  return src.split('\n').map(line => {
    if (line.length <= limit || line.trimStart().startsWith('%')) return line;
    let out = '';
    let rest = line;
    while (rest.length > limit) {
      const cut = rest.lastIndexOf(' ', limit);
      if (cut <= 0) break; // no usable space — leave the rest as is
      out += rest.slice(0, cut) + '\n';
      rest = rest.slice(cut + 1);
    }
    return out + rest;
  }).join('\n');
}

/* ------------------------------------------------------------------ */
/* autocomplete: citation keys + \ref/\eqref/\label targets            */
/* ------------------------------------------------------------------ */

// anchored to the end only: the command must sit directly before the '{'
const AC_UNITS = [
  ['m', 'metre — length'], ['km', 'kilometre'], ['cm', 'centimetre'], ['mm', 'millimetre'],
  ['kg', 'kilogram — mass'], ['g', 'gram'], ['mg', 'milligram'],
  ['s', 'second — time'], ['ms', 'millisecond'], ['min', 'minute'], ['h', 'hour'], ['d', 'day'],
  ['A', 'ampere — current'], ['K', 'kelvin — temperature'], ['degC', 'degree Celsius'],
  ['mol', 'mole — amount'], ['cd', 'candela'],
  ['m/s', 'velocity'], ['km/h', 'velocity'], ['m/s^2', 'acceleration'],
  ['N', 'newton — force'], ['Pa', 'pascal — pressure'], ['hPa', 'hectopascal'], ['kPa', 'kilopascal'],
  ['J', 'joule — energy'], ['kJ', 'kilojoule'], ['kWh', 'kilowatt hour'], ['eV', 'electronvolt'],
  ['W', 'watt — power'], ['kW', 'kilowatt'], ['MW', 'megawatt'], ['Hz', 'hertz — frequency'],
  ['C', 'coulomb — charge'], ['V', 'volt — voltage'], ['\Omega', 'ohm — resistance'],
  ['T', 'tesla — flux density'], ['Wb', 'weber'], ['H', 'henry — inductance'],
  ['lm', 'lumen'], ['lx', 'lux'], ['dB', 'decibel'], ['%', 'percent'],
].map(([u, d]) => ({u, d}));

const AC_CITE_RE = /\\(?:cite[a-zA-Z]*|Cite[pt])\*?(?:\[[^\]]*\])*$/;
const AC_REF_RE = /\\(?:ref|eqref|cref|Cref|autoref|pageref|label)\*?$/;

// the most common commands, ordered by usefulness; insert uses '|' as the
// caret marker after insertion
const AC_COMMANDS = [
  {t: 'section', i: '\\section{|}', c: 'structure'},
  {t: 'subsection', i: '\\subsection{|}', c: 'structure'},
  {t: 'subsubsection', i: '\\subsubsection{|}', c: 'structure'},
  {t: 'paragraph', i: '\\paragraph{|}', c: 'structure'},
  {t: 'citep', i: '\\citep{|}', c: 'citation'},
  {t: 'citet', i: '\\citet{|}', c: 'citation'},
  {t: 'cite', i: '\\cite{|}', c: 'citation'},
  {t: 'citealp', i: '\\citealp{|}', c: 'citation'},
  {t: 'citeauthor', i: '\\citeauthor{|}', c: 'citation'},
  {t: 'citeyear', i: '\\citeyear{|}', c: 'citation'},
  {t: 'ref', i: '\\ref{|}', c: 'reference'},
  {t: 'eqref', i: '\\eqref{|}', c: 'reference'},
  {t: 'cref', i: '\\cref{|}', c: 'reference'},
  {t: 'label', i: '\\label{|}', c: 'reference'},
  {t: 'footnote', i: '\\footnote{|}', c: 'text'},
  {t: 'textbf', i: '\\textbf{|}', c: 'text'},
  {t: 'textit', i: '\\textit{|}', c: 'text'},
  {t: 'emph', i: '\\emph{|}', c: 'text'},
  {t: 'underline', i: '\\underline{|}', c: 'text'},
  {t: 'texttt', i: '\\texttt{|}', c: 'text'},
  {t: 'SI', i: '\\SI{|}{}', c: 'units (siunitx)'},
  {t: 'qty', i: '\\qty{|}{}', c: 'units (siunitx)'},
  {t: 'num', i: '\\num{|}', c: 'units (siunitx)'},
  {t: 'si', i: '\\si{|}', c: 'units (siunitx)'},
  {t: 'ang', i: '\\ang{|}', c: 'units (siunitx)'},
  {t: 'caption', i: '\\caption{|}', c: 'floats'},
  {t: 'includegraphics', i: '\\includegraphics[width=0.8\\textwidth]{|}', c: 'floats'},
  {t: 'item', i: '\\item ', c: 'lists'},
  {t: 'begin{itemize}', i: '\\begin{itemize}\n  \\item |\n\\end{itemize}', c: 'environment'},
  {t: 'begin{enumerate}', i: '\\begin{enumerate}\n  \\item |\n\\end{enumerate}', c: 'environment'},
  {t: 'begin{equation}', i: '\\begin{equation}\n  |\n  \\label{eq:}\n\\end{equation}', c: 'environment'},
  {t: 'begin{align}', i: '\\begin{align}\n  | &= \\\\\n  &=\n\\end{align}', c: 'environment'},
  {t: 'begin{figure}', i: '\\begin{figure}\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{|}\n  \\caption{}\n\\end{figure}', c: 'environment'},
  {t: 'begin{table}', i: '\\begin{table}\n  \\caption{|}\n  \\begin{tabular}{ll}\n    a & b \\\\\n  \\end{tabular}\n\\end{table}', c: 'environment'},
  {t: 'usepackage', i: '\\usepackage{|}', c: 'preamble'},
  {t: 'input', i: '\\input{|}', c: 'preamble'},
  {t: 'bibliography', i: '\\bibliography{|}', c: 'preamble'},
];

// what is being typed at the caret? returns {kind, typed} or null
function acContext(ta) {
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  // 1) inside the braces of a cite/ref-type command → key completion
  const brace = before.lastIndexOf('{');
  if (brace >= 0) {
    const partial = before.slice(brace + 1);
    if (!/[{}]/.test(partial)) {
      const cmd = before.slice(0, brace);
      const typed = partial.slice(partial.lastIndexOf(',') + 1).trimStart();
      if (AC_CITE_RE.test(cmd)) return {kind: 'cite', typed};
      if (AC_REF_RE.test(cmd)) return {kind: 'ref', typed};
      // unit positions: second brace of \SI{val}{ and the brace of \si{val}
      if (/\\SI\{[^{}]*\}$/.test(cmd) || /\\si$/.test(cmd)) {
        return {kind: 'unit', typed};
      }
    }
  }
  // 2) a (partial) command name → command completion; a backslash directly
  //    behind another backslash is an escaped \\ line break, not a command
  const m = /\\([a-zA-Z]*)$/.exec(before);
  if (m && !(m.index > 0 && before[m.index - 1] === '\\')) {
    return {kind: 'cmd', typed: m[1].toLowerCase(), start: m.index};
  }
  return null;
}

// suggestion items for the current context, filtered by the typed text
function acSuggestions(kind, typed) {
  const t = typed.toLowerCase();
  if (kind === 'cmd') {
    return AC_COMMANDS.filter(c => c.t.toLowerCase().startsWith(t))
      .slice(0, 12)
      .map(c => ({insert: c.i, title: '\\' + c.t, sub: c.c}));
  }
  let items = [];
  if (kind === 'unit') {
    return AC_UNITS.filter(u => u.u.toLowerCase().startsWith(t) || u.d.toLowerCase().includes(t))
      .slice(0, 12).map(u => ({insert: u.u, title: u.u, sub: u.d}));
  }
  if (kind === 'cite') {
    if (state.bib && state.bib.available) {
      items = state.bib.entries.map(e => ({
        insert: e.key,
        title: e.key,
        sub: [e.authors, e.year].filter(Boolean).join(', ') +
          (e.plain ? ' — ' + e.plain.slice(0, 90) : ''),
      }));
    } else {
      // no compiled .bbl — offer the keys already cited in the document
      const used = new Set();
      for (const b of state.doc.blocks) {
        const re = /\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^{}]+)\}/g;
        let m;
        while ((m = re.exec(b.source))) {
          m[1].split(',').forEach(k => used.add(k.trim()));
        }
      }
      items = [...used].filter(Boolean)
        .map(k => ({insert: k, title: k, sub: 'already cited in document'}));
    }
  } else {
    const typeNames = {math: 'equation', figure: 'figure', table: 'table'};
    const seen = new Set();
    for (const b of state.doc.blocks) {
      const re = /\\label\{([^{}]+)\}/g;
      let m;
      while ((m = re.exec(b.source))) {
        const label = m[1];
        if (seen.has(label)) continue;
        seen.add(label);
        const sub = b.type === 'section'
          ? 'section — ' + ((b.meta && b.meta.title) || '')
          : (typeNames[b.type] || b.type) + ' in ' + b.file;
        items.push({insert: label, title: label, sub});
      }
    }
  }
  return items.filter(i => i.title.toLowerCase().includes(t)).slice(0, 12);
}

// live autocomplete popups → their textareas; a popup whose editor left the
// DOM (re-render without blur) would otherwise linger forever
const _acPops = new Map();

function closeOrphanAutocomplete() {
  for (const [pop, ta] of [..._acPops]) {
    if (!ta.isConnected) {
      pop.remove();
      _acPops.delete(pop);
    }
  }
}

// caret-anchored completion popup for a plain textarea; keyboard: ↑↓ select,
// Enter/Tab insert, Esc close — Esc does not reach other handlers while open
function attachAutocomplete(ta) {
  let pop = null, items = [], sel = 0;

  const close = () => {
    if (pop) { pop.remove(); _acPops.delete(pop); pop = null; }
  };

  const render = () => {
    pop.innerHTML = '';
    items.forEach((it, ix) => {
      const row = el('button', 'acitem' + (ix === sel ? ' sel' : ''));
      row.type = 'button';
      row.innerHTML = `<span class="actitle">${esc(it.title)}</span>` +
        (it.sub ? `<span class="acsub">${esc(it.sub)}</span>` : '');
      row.onmousedown = ev => { ev.preventDefault(); choose(ix); };
      pop.append(row);
    });
  };

  const choose = ix => {
    const it = items[ix];
    if (!it) { close(); return; }
    const pos = ta.selectionStart;
    const c = acContext(ta);
    let start = pos;
    if (c && c.kind === 'cmd') {
      start = c.start; // replace the whole partial command incl. backslash
    } else {
      const before = ta.value.slice(0, pos);
      const brace = before.lastIndexOf('{');
      const partial = before.slice(brace + 1);
      start = brace + 1 + partial.lastIndexOf(',') + 1;
    }
    const marker = it.insert.indexOf('|');
    const text = marker >= 0 ? it.insert.replace('|', '') : it.insert;
    ta.setRangeText(text, start, pos, 'end');
    if (marker >= 0) ta.setSelectionRange(start + marker, start + marker);
    close();
    ta.dispatchEvent(new Event('input', {bubbles: true})); // refresh preview
    ta.focus();
  };

  // caret position via a mirror div with the textarea's exact typography
  const position = () => {
    const cs = getComputedStyle(ta);
    const div = document.createElement('div');
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
      'padding', 'border', 'letterSpacing', 'boxSizing', 'tabSize']) {
      div.style[p] = cs[p];
    }
    div.style.position = 'absolute';
    div.style.visibility = 'hidden';
    div.style.whiteSpace = 'pre-wrap';
    div.style.wordWrap = 'break-word';
    div.style.width = ta.clientWidth + 'px';
    document.body.append(div);
    div.textContent = ta.value.slice(0, ta.selectionStart);
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    div.append(marker);
    const taRect = ta.getBoundingClientRect();
    const mr = marker.getBoundingClientRect();
    const dr = div.getBoundingClientRect();
    let left = taRect.left + (mr.left - dr.left);
    let top = taRect.top + (mr.top - dr.top) + parseFloat(cs.lineHeight || '20');
    left = Math.min(left, window.innerWidth - 300);
    pop.style.left = (left + window.scrollX) + 'px';
    pop.style.top = (top + window.scrollY) + 'px';
    div.remove();
  };

  const update = () => {
    const c = acContext(ta);
    items = c ? acSuggestions(c.kind, c.typed) : [];
    if (!items.length) { close(); return; }
    sel = 0;
    if (!pop) {
      pop = el('div', 'acpopup');
      document.body.append(pop);
      _acPops.set(pop, ta);
    }
    render();
    position();
  };

  ta.addEventListener('input', update);
  ta.addEventListener('click', update);
  ta.addEventListener('keydown', e => {
    if (!pop) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      sel = (sel + d + items.length) % items.length;
      render();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      choose(sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }, true);
  ta.addEventListener('blur', () => setTimeout(close, 150));
}

function buildEditor(b, kind) {
  const ed = {root: el('div', 'editor'), kind};
  const bar = el('div', 'edbar');
  const commitBtn = el('button', 'edbtn primary', '✓ Save');
  const cancelBtn = el('button', 'edbtn', 'Cancel');
  bar.append(cancelBtn, el('span', 'spacer'), commitBtn);
  ed.root.append(bar);

  const commit = async () => {
    const src = reflowLongLines(ed.getValue());
    if (src === state.edit.original) { closeEditor(); return; }
    const editRef = state.edit;
    if (editRef.kind === 'math') dismissMathKeyboard(editRef.root.root);
    try {
      const res = await ppost(`/block/${editRef.id}/save`, {source: src});
      state.edit = null;
      applyDoc(res.doc);
      toast('Saved');
      checkBlocks([editRef.id]); // background re-check of the edited block
    } catch (e) {
      handleOpError(e, editRef.block);
    }
  };
  const cancel = () => closeEditor();

  commitBtn.onclick = commit;
  cancelBtn.onclick = cancel;

  if (kind === 'source') {
    bar.append(el('span', 'hint', 'Ctrl+Enter saves · Esc cancels'));
    const ta = el('textarea');
    ta.value = b.source;
    ta.rows = Math.min(Math.max(b.source.split('\n').length + 1, 3), 24);
    ta.spellcheck = false;
    attachAutocomplete(ta); // cite keys + \ref/\label targets
    ed.root.append(ta);
    const prev = el('div', 'edpreview');
    const upd = () => { prev.innerHTML = renderBlockContent({...b, source: ta.value}); };
    ta.addEventListener('input', upd);
    upd();
    ed.root.append(prev);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    });
    ed.getValue = () => ta.value;
    ed.focus = () => ta.focus();
    return ed;
  }

  if (kind === 'math') return buildMathEditor(b, ed, bar, commit, cancel);
  if (kind === 'grid') return buildGridEditor(b, ed, bar, commit, cancel);
  return ed;
}

/* ---- math editor (MathLive visual, LaTeX source fallback) ---- */

function buildMathEditor(b, ed, bar, commit, cancel) {
  const wrap = (b.meta && b.meta.wrap) || 'dollars';
  const inner = mathInner(b);
  const labels = [];
  const innerNoLabels = inner.replace(/\\label\{([^}]*)\}/g, (_, l) => {
    labels.push(l);
    return '';
  }).trim();

  const hasMathLive = typeof customElements !== 'undefined' &&
    customElements.get('math-field');
  let mode = hasMathLive ? 'visual' : 'source';

  const toggle = el('button', 'edbtn', mode === 'visual' ? 'LaTeX source' : 'Visual editor');
  bar.append(el('span', 'hint', 'Ctrl+Enter saves · Esc cancels'), toggle);

  const visual = el('div');
  const srcWrap = el('div');
  let mf = null;

  if (hasMathLive) {
    mf = document.createElement('math-field');
    mf.value = innerNoLabels;
    visual.append(mf);
  }

  const ta = el('textarea');
  ta.value = innerNoLabels;
  ta.rows = Math.min(Math.max(innerNoLabels.split('\n').length + 1, 3), 18);
  ta.spellcheck = false;
  const prev = el('div', 'edpreview');
  srcWrap.append(ta, prev);
  const updSrc = () => { prev.innerHTML = katexSpan(ta.value, true); };
  ta.addEventListener('input', updSrc);

  ed.root.append(visual, srcWrap);
  if (mode === 'source') { updSrc(); }
  else { srcWrap.classList.add('hidden'); }

  toggle.onclick = () => {
    if (mode === 'visual') {
      ta.value = mf.value;
      mode = 'source';
      srcWrap.classList.remove('hidden');
      visual.classList.add('hidden');
      toggle.textContent = 'Visual editor';
      updSrc();
      ta.focus();
    } else {
      mf.value = ta.value;
      mode = 'visual';
      visual.classList.remove('hidden');
      srcWrap.classList.add('hidden');
      toggle.textContent = 'LaTeX source';
    }
  };

  ed.getValue = () => {
    const body = (mode === 'visual' ? mf.value : ta.value).trim();
    const labelStr = labels.map(l => `\\label{${l}}`).join(' ');
    return mathWrap(wrap, (body + (labelStr ? '\n' + labelStr : '')).trim());
  };
  ed.focus = () => (mode === 'visual' && mf) ? mf.focus() : ta.focus();

  if (mf) {
    mf.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    });
  }

  // catch the keyboard opening shortly after focus — animations and late
  // layout can lag the events, so poll briefly as a safety net
  if (window._syncKeyboardSpace) {
    let polls = 0;
    const t = setInterval(() => {
      if (!document.querySelector('.block.editing math-field') || polls++ > 8) {
        clearInterval(t);
        return;
      }
      window._syncKeyboardSpace();
    }, 100);
  }
  return ed;
}

/* ---- table grid editor ---- */

function buildGridEditor(b, ed, bar, commit, cancel) {
  const model = parseTableRich(b.source); // non-null: openEditor gates the kind
  let sel = {r: 0, c: 0};
  let pane = 'grid';

  // ---- logical column helpers (multicolumn cells span several) ----------
  const rowSpans = row => row.cells.map(c => (c.mc && c.mc.n > 1 ? c.mc.n : 1));
  const logicalCols = row => rowSpans(row).reduce((a, s) => a + s, 0);
  const ncols = () => Math.max(1, ...model.rows.map(logicalCols));
  const cellIndexForCol = (row, c) => {
    let pos = 0;
    const spans = rowSpans(row);
    for (let i = 0; i < spans.length; i++) {
      if (c < pos + spans[i]) return {i, mid: c > pos};
      pos += spans[i];
    }
    return {i: row.cells.length - 1, mid: false};
  };

  // ---- structural operations (all keep the selection sensible) ----------
  const blankCell = () => ({text: '', mc: null});
  const ops = {
    addRow: at => {
      // rules glue to the row they precede: inserting at `at` pushes
      // every boundary at or below the insert point down by one
      model.rules.forEach(rl => { if (rl.before >= at) rl.before++; });
      model.rows.splice(at, 0, {cells: Array(ncols()).fill(null).map(blankCell), spacing: ''});
      sel = {r: at, c: sel.c};
      redraw();
    },
    delRow: r => {
      if (model.rows.length <= 1) return;
      // deleting row r merges its two boundaries: rules that sat below
      // it move up with the row they precede
      model.rules.forEach(rl => {
        if (rl.before === r + 1) rl.before = r;
        else if (rl.before > r + 1) rl.before--;
      });
      model.rows.splice(r, 1);
      // rules bound past the new end clamp onto the last boundary
      model.rules.forEach(rl => { if (rl.before > model.rows.length) rl.before = model.rows.length; });
      sel = {r: Math.min(r, model.rows.length - 1), c: sel.c};
      redraw();
    },
    moveRow: (r, dir) => {
      const t = r + dir;
      if (t < 0 || t >= model.rows.length) return;
      [model.rows[r], model.rows[t]] = [model.rows[t], model.rows[r]];
      // rules attached to the moving boundary travel with the swap
      const rb = bIdx => model.rules.filter(x => x.before === bIdx);
      const lo = Math.min(r, t) + 1, hi = Math.max(r, t) + 1;
      const a = rb(lo), c2 = rb(hi);
      a.forEach(x => x.before = hi); c2.forEach(x => x.before = lo);
      sel = {r: t, c: sel.c};
      redraw();
    },
    addCol: at => {
      model.rows.forEach(row => {
        const {i, mid} = cellIndexForCol(row, at);
        if (mid) {
          if (row.cells[i].mc) row.cells[i].mc.n++;
        } else {
          row.cells.splice(i === -1 ? row.cells.length : i, 0, blankCell());
        }
      });
      sel = {r: sel.r, c: at};
      redraw();
    },
    delCol: c => {
      if (ncols() <= 1) return;
      model.rows.forEach(row => {
        const {i, mid} = cellIndexForCol(row, c);
        const cell = row.cells[i];
        if (cell && cell.mc && cell.mc.n > 1) {
          cell.mc.n--;
          if (cell.mc.n === 1) cell.mc = null;
        } else {
          row.cells.splice(i, 1);
        }
        if (!row.cells.length) row.cells.push(blankCell());
      });
      sel = {r: sel.r, c: Math.min(c, ncols() - 1)};
      redraw();
    },
    moveCol: (c, dir) => {
      const t = c + dir;
      if (t < 0 || t >= ncols()) return;
      model.rows.forEach(row => {
        const a = cellIndexForCol(row, c);
        const bv = cellIndexForCol(row, t);
        if (a.mid || bv.mid) return; // spans crossing — leave advanced rows alone
        const [cell] = row.cells.splice(a.i, 1);
        row.cells.splice(bv.i, 0, cell);
      });
      sel = {r: sel.r, c: t};
      redraw();
    },
  };

  // ---- rules -------------------------------------------------------------
  const rulesAt = bIdx => model.rules.filter(r => r.before === bIdx);
  const defaultKind = bIdx =>
    bIdx === 0 ? 'toprule' : (bIdx === model.rows.length ? 'bottomrule' : 'midrule');
  const cycleKind = (bIdx, kind) => {
    if (kind === 'cline' || kind === 'cmidrule') return defaultKind(bIdx);
    if (bIdx === 0) return kind === 'toprule' ? 'hline' : 'toprule';
    if (bIdx === model.rows.length) return kind === 'bottomrule' ? 'hline' : 'bottomrule';
    return kind === 'midrule' ? 'hline' : 'midrule';
  };
  const headerOn = () =>
    rulesAt(0).some(r => r.kind === 'toprule') &&
    rulesAt(1).some(r => r.kind === 'midrule') &&
    rulesAt(model.rows.length).some(r => r.kind === 'bottomrule');
  const toggleHeader = () => {
    const strip = bIdx => {
      model.rules = model.rules.filter(r =>
        !(r.before === bIdx && ['toprule', 'midrule', 'bottomrule'].includes(r.kind)));
    };
    if (headerOn()) {
      [0, 1, model.rows.length].forEach(strip);
    } else {
      [0, 1, model.rows.length].forEach(strip);
      model.rules.push({before: 0, kind: 'toprule', arg: ''});
      model.rules.push({before: 1, kind: 'midrule', arg: ''});
      model.rules.push({before: model.rows.length, kind: 'bottomrule', arg: ''});
    }
    redraw();
  };

  // ---- panes ---------------------------------------------------------
  const gridPane = el('div', 'tgrid');
  const srcPane = el('div', 'tgridsrc hidden');
  let srcTa = null, srcPrev = null;
  ed.root.append(gridPane, srcPane);

  const tools = el('div', 'gtools');
  const mkBtn = (label, title, fn) => {
    const btn = el('button', 'edbtn', label);
    btn.title = title;
    btn.onclick = fn;
    return btn;
  };
  const headerBtn = mkBtn('▤ Header rules', 'Apply the canonical booktabs pattern: toprule above the first row, midrule below it, bottomrule at the end', toggleHeader);
  tools.append(
    headerBtn,
    mkBtn('+ Row', 'Insert a row at the selection', () => ops.addRow(sel.r)),
    mkBtn('+ Col', 'Insert a column at the selection', () => ops.addCol(sel.c)),
    mkBtn('− Row', 'Delete the selected row', () => ops.delRow(sel.r)),
    mkBtn('− Col', 'Delete the selected column', () => ops.delCol(sel.c)),
  );
  if (model.advanced) {
    const adv = el('span', 'gadv', 'advanced constructs preserved');
    adv.title = 'This table contains \\multicolumn/\\multirow/\\cline/\\cmidrule. ' +
      'Cell text and layout are preserved; structural edits act best-effort.';
    tools.append(adv);
  }
  tools.append(el('span', 'hint',
    'Tab/Enter/arrows navigate · Shift+Enter newline · Ctrl+Enter saves'));
  gridPane.append(tools);

  // caption / label row
  const capRow = el('div', 'gcap');
  const capIn = el('input');
  capIn.placeholder = 'Caption';
  const capPos = el('select');
  [['below', 'below'], ['above', 'above']].forEach(([v, l]) => {
    const o = el('option', '', l);
    o.value = v;
    capPos.append(o);
  });
  const lblIn = el('input');
  lblIn.placeholder = 'label';
  capRow.append(el('span', 'gcaplbl', 'Caption'), capIn, capPos,
    el('span', 'gcaplbl', 'Label'), lblIn);
  if (model.caption) { capIn.value = model.caption.text; capPos.value = model.caption.pos; }
  if (model.label) lblIn.value = model.label;
  if (!model.wrap) {
    capIn.disabled = lblIn.disabled = capPos.disabled = true;
    capIn.title = 'captions need a table environment wrapper';
  } else {
    capIn.addEventListener('input', () => {
      if (!capIn.value.trim()) { model.caption = null; updatePreview(); return; }
      if (!model.caption) model.caption = {text: '', short: null, pos: capPos.value};
      model.caption.text = capIn.value;
      updatePreview();
    });
    capPos.addEventListener('change', () => {
      if (model.caption) { model.caption.pos = capPos.value; updatePreview(); }
    });
    lblIn.addEventListener('input', () => {
      model.label = lblIn.value.trim() || null;
      updatePreview();
    });
  }
  gridPane.append(capRow);

  // colspec / width row
  const specRow = el('div', 'gcols');
  const specIn = el('input');
  specIn.value = model.colspec;
  specIn.placeholder = 'l c r X p{3cm} …';
  specRow.append(el('span', 'gcaplbl', 'Columns'), specIn);
  if (model.widthArg !== null) {
    const wIn = el('input');
    wIn.value = model.widthArg;
    wIn.placeholder = '\\linewidth';
    specRow.append(el('span', 'gcaplbl', 'Width'), wIn);
    wIn.addEventListener('input', () => { model.widthArg = wIn.value; updatePreview(); });
  }
  specIn.addEventListener('input', () => { model.colspec = specIn.value; updatePreview(); });
  gridPane.append(specRow);

  // ---- the grid ------------------------------------------------------
  const tbl = el('table', 'gedit');
  gridPane.append(tbl);
  let cellInputs = [];

  const gutterBtn = (label, title, fn) => {
    const btn = el('button', 'tgbtn', label);
    btn.title = title;
    btn.tabIndex = -1;
    btn.onclick = e => { e.preventDefault(); e.stopPropagation(); fn(); };
    return btn;
  };

  const caretAtEdge = (ta, which) => {
    if (which === 'left') return ta.selectionStart === 0 && ta.selectionEnd === 0;
    if (which === 'right') return ta.selectionStart === ta.value.length
      && ta.selectionEnd === ta.value.length;
    if (which === 'up') return ta.value.slice(0, ta.selectionStart).indexOf('\n') < 0;
    return ta.value.slice(ta.selectionEnd).indexOf('\n') < 0; // down
  };
  const focusCell = (r, c, caretEnd = true) => {
    const row = model.rows[r];
    if (!row) return;
    // programmatic focus does not reliably fire the focus listener in
    // every embedded browser — set the selection authoritatively here
    sel = {r, c: Math.min(c, Math.max(0, logicalCols(row) - 1))};
    const {i} = cellIndexForCol(row, Math.min(c, logicalCols(row) - 1));
    const ta = cellInputs.find(x => x._r === r && x._i === i);
    if (!ta) return;
    ta.focus();
    if (caretEnd) ta.setSelectionRange(ta.value.length, ta.value.length);
    highlightSel(r, c);
  };
  const highlightSel = (r, c) => {
    tbl.querySelectorAll('.selcol,.selrow').forEach(x =>
      x.classList.remove('selcol', 'selrow'));
    const tr = tbl.querySelector(`tr[data-r="${r}"]`);
    if (tr) tr.classList.add('selrow');
    const row = model.rows[r];
    if (!row) return;
    const {i} = cellIndexForCol(row, Math.min(c, logicalCols(row) - 1));
    const td = tr && tr.querySelector(`td[data-i="${i}"]`);
    if (td) td.classList.add('selcol');
  };

  const moveSel = (dc, dr) => {
    const maxC = ncols() - 1;
    let {r, c} = sel;
    if (dc) {
      c += dc;
      if (c < 0) { c = maxC; r = Math.max(0, r - 1); }
      else if (c > maxC) { c = 0; r = Math.min(model.rows.length - 1, r + 1); }
    }
    if (dr) r = Math.max(0, Math.min(model.rows.length - 1, r + dr));
    sel = {r, c};
    focusCell(r, c);
  };

  const ruleGapTr = bIdx => {
    const tr = el('tr', 'rulegap');
    const td = el('td');
    td.colSpan = ncols() + 1;
    const rules = rulesAt(bIdx);
    if (rules.length) {
      rules.forEach(rl => {
        const chip = el('span', 'rulechip',
          '\\' + rl.kind + (rl.arg && rl.arg.trim() ? '…' : ''));
        chip.title = 'Click to change, ✕ removes — ' + rl.kind + rl.arg;
        chip.onclick = () => {
          rl.kind = cycleKind(bIdx, rl.kind);
          rl.arg = '';
          redraw();
        };
        const x = el('button', 'tgbtn', '✕');
        x.title = 'Remove this rule';
        x.tabIndex = -1;
        x.onclick = e => {
          e.preventDefault();
          model.rules.splice(model.rules.indexOf(rl), 1);
          redraw();
        };
        chip.append(x);
        td.append(chip);
      });
    } else {
      const add = el('span', 'ruleadd', '+ rule');
      add.title = 'Insert ' + defaultKind(bIdx);
      add.onclick = () => {
        model.rules.push({before: bIdx, kind: defaultKind(bIdx), arg: ''});
        redraw();
      };
      td.append(add);
    }
    tr.append(td);
    return tr;
  };

  function redraw() {
    tbl.innerHTML = '';
    cellInputs = [];
    const maxC = ncols();

    // column gutter (header row)
    const head = el('tr');
    head.append(el('td', 'gcorner'));
    for (let c = 0; c < maxC; c++) {
      const td = el('td', 'gcol');
      td.append(el('span', 'gcollabel', String.fromCharCode(65 + c % 26)));
      const btns = el('span', 'tgbtns');
      btns.append(
        gutterBtn('＋', 'Insert column left', () => ops.addCol(c)),
        gutterBtn('✕', 'Delete column', () => ops.delCol(c)),
        gutterBtn('←', 'Move column left', () => ops.moveCol(c, -1)),
        gutterBtn('→', 'Move column right', () => ops.moveCol(c, 1)),
      );
      td.append(btns);
      head.append(td);
    }
    tbl.append(head, ruleGapTr(0));

    model.rows.forEach((row, r) => {
      const tr = el('tr');
      tr.dataset.r = r;
      const g = el('td', 'grow');
      g.append(el('span', 'gcollabel', String(r + 1)));
      const btns = el('span', 'tgbtns');
      btns.append(
        gutterBtn('＋', 'Insert row above', () => ops.addRow(r)),
        gutterBtn('✕', 'Delete row', () => ops.delRow(r)),
        gutterBtn('↑', 'Move row up', () => ops.moveRow(r, -1)),
        gutterBtn('↓', 'Move row down', () => ops.moveRow(r, 1)),
      );
      g.append(btns);
      tr.append(g);
      row.cells.forEach((cell, i) => {
        const td = el('td');
        td.dataset.i = i;
        if (cell.mc && cell.mc.n > 1) td.colSpan = cell.mc.n;
        const ta = el('textarea');
        ta.value = cell.text;
        ta.rows = 1;
        ta._r = r; ta._i = i;
        ta.addEventListener('focus', () => {
          sel = {r, c: logicalColOf(row, i)};
          highlightSel(r, sel.c);
        });
        ta.addEventListener('input', () => {
          cell.text = ta.value;
          ta.style.height = 'auto';
          ta.style.height = ta.scrollHeight + 'px';
          updatePreview();
        });
        ta.addEventListener('keydown', e => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault(); commit(); return;
          }
          if (e.key === 'Tab') { e.preventDefault(); moveSel(e.shiftKey ? -1 : 1, 0); return; }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); moveSel(0, 1); return; }
          if (e.key === 'ArrowUp' && caretAtEdge(ta, 'up')) { e.preventDefault(); moveSel(0, -1); return; }
          if (e.key === 'ArrowDown' && caretAtEdge(ta, 'down')) { e.preventDefault(); moveSel(0, 1); return; }
          if (e.key === 'ArrowLeft' && caretAtEdge(ta, 'left')) { e.preventDefault(); moveSel(-1, 0); return; }
          if (e.key === 'ArrowRight' && caretAtEdge(ta, 'right')) { e.preventDefault(); moveSel(1, 0); }
        });
        cellInputs.push(ta);
        td.append(ta);
        tr.append(td);
      });
      // pad short rows visually so the grid stays rectangular
      for (let p = logicalCols(row); p < maxC; p++) tr.append(el('td', 'gpad'));
      tbl.append(tr, ruleGapTr(r + 1));
    });

    headerBtn.classList.toggle('toggled', headerOn());
    updatePreview();
    focusCell(sel.r, sel.c);
  }

  const logicalColOf = (row, i) => {
    let pos = 0;
    const spans = rowSpans(row);
    for (let k = 0; k < i; k++) pos += spans[k];
    return pos;
  };

  // ---- live preview ---------------------------------------------------
  const preview = el('div', 'edpreview');
  gridPane.append(preview);
  let prevTimer = null;
  function updatePreview() {
    clearTimeout(prevTimer);
    prevTimer = setTimeout(() => {
      const src = serializeTableRich(model);
      const L = parseTabularLenient(src);
      if (L) {
        preview.innerHTML = '<div class="tabwrap">' +
          renderTableHTML(L.grid) +
          (L.caption ? `<figcaption class="figcap">${renderInline(L.caption)}</figcaption>` : '') +
          '</div>';
      } else {
        preview.innerHTML = '<pre class="kerr">' + esc(src) + '</pre>';
      }
    }, 120);
  }

  // ---- source pane (escape hatch) --------------------------------------
  const srcBtn = el('button', 'edbtn', 'LaTeX source');
  srcBtn.title = 'Edit the raw LaTeX of this table';
  bar.insertBefore(srcBtn, bar.firstChild);
  const buildSrcPane = () => {
    srcPane.innerHTML = '';
    srcTa = el('textarea');
    srcTa.spellcheck = false;
    srcTa.value = serializeTableRich(model);
    attachAutocomplete(srcTa);
    srcPrev = el('div', 'edpreview');
    const upd = () => {
      const L = parseTabularLenient(srcTa.value);
      srcPrev.innerHTML = L
        ? '<div class="tabwrap">' + renderTableHTML(L.grid) +
          (L.caption ? `<figcaption class="figcap">${renderInline(L.caption)}</figcaption>` : '') + '</div>'
        : '';
    };
    srcTa.addEventListener('input', upd);
    srcTa.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    });
    upd();
    srcPane.append(srcTa, srcPrev);
  };
  srcBtn.onclick = () => {
    if (pane === 'grid') {
      buildSrcPane();
      pane = 'src';
      gridPane.classList.add('hidden');
      srcPane.classList.remove('hidden');
      srcBtn.textContent = 'Visual editor';
      srcTa.focus();
    } else {
      const m2 = parseTableRich(srcTa.value);
      if (!m2) {
        toast('Cannot return to the visual editor — the LaTeX no longer fits', true);
        return;
      }
      Object.assign(model, m2);
      pane = 'grid';
      srcPane.classList.add('hidden');
      gridPane.classList.remove('hidden');
      srcBtn.textContent = 'LaTeX source';
      sel = {r: 0, c: 0};
      redraw();
    }
  };

  redraw();

  ed.getValue = () => pane === 'grid' ? serializeTableRich(model) : srcTa.value;
  ed.focus = () => (pane === 'grid' ? focusCell(sel.r, sel.c) : srcTa && srcTa.focus());
  return ed;
}

/* ------------------------------------------------------------------ */
/* insert menu                                                         */
/* ------------------------------------------------------------------ */

const TEMPLATES = [
  ['Raw LaTeX', '% raw LaTeX — replace me'],
  ['Paragraph', 'New paragraph text. Edit me.'],
  ['Display equation', '\\[\ne^{i\\pi} = -1\n\\]'],
  ['Itemized list', '\\begin{itemize}\n\\item First point\n\\item Second point\n\\end{itemize}'],
  ['Table', '\\begin{tabular}{ll}\nAlpha & Beta \\\\\nGamma & Delta\n\\end{tabular}'],
  ['Section', '\\section{New section}'],
  ['Figure', '\\begin{figure}\n\\centering\n\\includegraphics{figures/plot.png}\n\\caption{A caption.}\n\\end{figure}'],
];

function showInsertMenu(b, ev) {
  closeInsertMenu();
  const menu = el('div');
  menu.id = 'insertmenu';
  for (const [label, tmpl] of TEMPLATES) {
    const btn = el('button', '', label);
    btn.onclick = async () => {
      closeInsertMenu();
      try {
        const res = await ppost('/block/insert', {after: b.id, source: tmpl});
        applyDoc(res.doc);
        if (res.new_id) {
          const nb = blockById(res.new_id);
          if (nb) {
            scrollToBlock(nb.id);
            setTimeout(() => {
              openEditor(nb);
              // fresh source editors: hint text pre-selected, so the first
              // keystroke replaces it instead of appending
              const ta = document.querySelector('.block.editing textarea');
              if (ta && ta.offsetParent) {
                ta.placeholder = 'Write your ' + label.toLowerCase() + ' here…';
                ta.focus();
                ta.select();
              }
            }, 60);
          }
        }
        toast(label + ' inserted');
      } catch (e) { toast('Insert failed: ' + e.message, true); }
    };
    menu.append(btn);
  }
  document.body.append(menu);
  // pop up right next to the pointer
  const x = ev && ev.clientX ? ev.clientX : window.innerWidth - 200;
  const y = ev && ev.clientY ? ev.clientY : 60;
  menu.style.left = Math.min(x + 8, window.innerWidth - 190) + 'px';
  menu.style.top = Math.min(y + 6, window.innerHeight - 270) + 'px';
  setTimeout(() => document.addEventListener('click', closeInsertMenu, {once: true}), 0);
}

function closeInsertMenu() {
  const m = $('#insertmenu');
  if (m) m.remove();
}

/* ------------------------------------------------------------------ */
/* raw file editor                                                     */
/* ------------------------------------------------------------------ */

async function openRaw(path) {
  let data;
  try { data = await papi('/file?path=' + encodeURIComponent(path)); }
  catch (e) { toast('Cannot open raw: ' + e.message, true); return; }

  const overlay = el('div');
  overlay.id = 'rawoverlay';
  const wrap = el('div', 'rawwrap');
  wrap.append(el('h3', '', 'raw: ' + path));
  const ta = el('textarea');
  ta.value = data.source;
  ta.spellcheck = false;
  attachAutocomplete(ta); // cite keys + \ref/\label targets
  wrap.append(ta);
  const bar = el('div', 'edbar');
  const closeBtn = el('button', 'edbtn', 'Close');
  const saveBtn = el('button', 'edbtn primary', '✓ Save file');
  bar.append(closeBtn, el('span', 'spacer'), saveBtn);
  wrap.append(bar);
  overlay.append(wrap);
  document.body.append(overlay);

  const escClose = ev => { if (ev.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', escClose, true);
    overlay.remove();
  };
  document.addEventListener('keydown', escClose, true);

  closeBtn.onclick = close;
  overlay.addEventListener('click', e => {
    if (e.target === overlay) close();
  });
  saveBtn.onclick = async () => {
    try {
      const res = await papi('/file', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path, source: reflowLongLines(ta.value)}),
      });
      close();
      applyDoc(res.doc);
      toast('Saved ' + path);
      checkDocument(); // raw edits can touch any block — full re-check
    } catch (e) { toast('Raw save failed: ' + e.message, true); }
  };
  ta.focus();
}

/* ------------------------------------------------------------------ */
/* projects: add from disk (server-side browser), switch, remove       */
/* ------------------------------------------------------------------ */

async function refreshProjects(preferId) {
  state.projects = (await api('/api/projects'))
    .sort((a, b) => b.last_accessed - a.last_accessed); // most recent first
  if (preferId && state.projects.some(p => p.id === preferId)) {
    state.project = preferId;
  } else if (!state.projects.some(p => p.id === state.project)) {
    state.project = state.projects.length ? state.projects[0].id : null;
  }
  if (state.project) await refreshDoc();
  else { state.doc = null; renderAll(); }
}

function switchProject(pid) {
  if (pid === state.project) return;
  if (state.edit) closeEditor();
  state.project = pid;
  // don't let the previous project's change set bleed into the new one
  state.git = null;
  state.gitChanged = new Set();
  state.gitShowDiff = false;
  state.gitDiff = {diffs: {}, ghosts: []};
  // proof issues are document-specific
  state.proof.issues = [];
  state.proof.checked = false;
  refreshDoc().then(() => {
    // auto-check only once the new document is in state — otherwise
    // results would be mapped onto the previous project's blocks
    if (state.project === pid) loadProofConfig();
    if (state.project === pid) refreshBib();
  });
}

async function removeProject(pid) {
  const target = pid || state.project;
  if (!target) return;
  const p = state.projects.find(x => x.id === target);
  if (!confirm(`Remove project "${p ? p.name : target}" from the editor?\n(Files on disk are not touched.)`)) return;
  try {
    await api(`/api/project/${target}`, {method: 'DELETE'});
    if (state.project === target) {
      state.project = null;
      state.doc = null;
    }
    await refreshProjects();
    toast('Project removed');
  } catch (e) { toast('Remove failed: ' + e.message, true); }
}

/* ------------------------------------------------------------------ */
/* LaTeX compilation                                                   */
/* ------------------------------------------------------------------ */

async function compileProject(pid) {
  const target = pid || state.project;
  if (!target) return;
  const bar = $('#compiling');
  const pname = (state.projects.find(p => p.id === target) || {}).name || '';
  bar.innerHTML = `<span class="spin"></span> Compiling PDF — <b>${esc(pname)}</b>… ` +
    '<span class="compilinghint">large documents can take a while</span>';
  bar.classList.remove('hidden');
  try {
    const res = await post(`/api/project/${target}/compile`, {});
    if (target === state.project) {
      refreshBib(); // the .bbl just changed — resolve citations with it
    }
    window.open(res.pdf + '?t=' + Date.now(), '_blank');
    if (res.clean === false && res.log) {
      showCompileLog('The PDF was produced, but LaTeX reported problems:\n\n' + res.log);
    } else {
      toast('PDF compiled');
    }
  } catch (e) {
    showCompileLog(e.message);
  } finally {
    bar.classList.add('hidden');
  }
}

function showCompileLog(msg) {
  const old = $('#compilelog');
  if (old) old.remove();
  const overlay = el('div');
  overlay.id = 'compilelog';
  const wrap = el('div', 'rawwrap');
  wrap.append(el('h3', '', 'Compilation failed'));
  const pre = el('pre', 'compilelogpre', esc(msg));
  wrap.append(pre);
  const bar = el('div', 'edbar');
  const closeBtn = el('button', 'edbtn', 'Close');
  bar.append(el('span', 'spacer'), closeBtn);
  wrap.append(bar);
  overlay.append(wrap);
  document.body.append(overlay);
  const close = () => overlay.remove();
  closeBtn.onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

// add project via the built-in disk browser (type/paste a path or navigate)
async function addProject() {
  openBrowseModal();
}

async function addProjectFile(fullPath) {
  try {
    const proj = await post('/api/projects', {path: fullPath});
    await refreshProjects(proj.id);
    toast('Project added: ' + proj.name);
    return true;
  } catch (e) {
    toast('Cannot add project: ' + e.message, true);
    return false;
  }
}

async function openBrowseModal() {
  const modal = $('#browsemodal');
  modal.classList.remove('hidden');
  modal.innerHTML = '';
  const wrap = el('div', 'browsecolumn');
  wrap.append(el('h3', '', 'Add project — pick a main .tex file'));

  // type or paste a path: .tex file → add directly, folder → navigate there
  const pathInput = el('input', 'browsepathinput');
  pathInput.placeholder = 'Type or paste a path (…\\project\\main.tex) and press Enter';
  pathInput.spellcheck = false;
  const tryPath = async () => {
    const p = pathInput.value.trim().replace(/^"(.*)"$/, '$1');
    if (!p) return;
    try {
      const data = await api('/api/browse?path=' + encodeURIComponent(p));
      if (data.file) {
        await addProjectFile(data.file);
        close();
        return;
      }
      await load(data.path);
    } catch (e) {
      toast('Path not found: ' + p, true);
    }
  };
  pathInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); tryPath(); }
  });
  pathInput.addEventListener('paste', () => {
    // let the pasted text land, then auto-navigate/add if it's a valid path
    setTimeout(tryPath, 0);
  });
  const openBtn = el('button', 'edbtn', 'Open');
  openBtn.onclick = tryPath;

  const pathbar = el('div', 'browsepath');
  const list = el('div', 'browselist');
  const bar = el('div', 'edbar');
  const cancelBtn = el('button', 'edbtn', 'Cancel');
  bar.append(el('span', 'spacer'), cancelBtn);
  wrap.append(pathInput, openBtn, pathbar, list, bar);
  modal.append(wrap);

  const escClose = ev => { if (ev.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', escClose, true);
    modal.classList.add('hidden');
    modal.innerHTML = '';
  };
  document.addEventListener('keydown', escClose, true);
  cancelBtn.onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  const load = async (path) => {
    const data = await api('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : ''));
    state.browsePath = data;
    pathbar.innerHTML = '';
    if (data.roots) {
      pathbar.append(el('span', '', 'Choose a drive:'));
      const roots = el('div', 'browseroots');
      for (const r of data.roots) {
        const b = el('button', 'edbtn', esc(r));
        b.onclick = () => load(r);
        roots.append(b);
      }
      pathbar.append(roots);
      list.innerHTML = '';
      return;
    }
    pathbar.append(el('code', '', esc(data.path)));
    if (data.parent) {
      const up = el('button', 'edbtn', '⬆ up');
      up.onclick = () => load(data.parent);
      pathbar.append(up);
    }
    list.innerHTML = '';
    for (const d of data.dirs) {
      const btn = el('button', 'browseitem dir', '📁 ' + esc(d));
      btn.onclick = () => load(data.path.replace(/[\\/]+$/, '') + '\\' + d);
      list.append(btn);
    }
    if (data.tex_files.length) list.append(el('div', 'sb-head', 'LaTeX files in this folder'));
    for (const f of data.tex_files) {
      const btn = el('button', 'browseitem tex', '📄 ' + esc(f));
      btn.onclick = async () => {
        const full = data.path.replace(/[\\/]+$/, '') + '\\' + f;
        if (await addProjectFile(full)) close();
      };
      list.append(btn);
    }
    if (!data.dirs.length && !data.tex_files.length) {
      list.append(el('div', '', '— empty —'));
    }
  };
  await load(state.browsePath ? state.browsePath.path : '');
}

/* ------------------------------------------------------------------ */
/* git: status panel, block highlighting, diff-only view, commit, push */
/* ------------------------------------------------------------------ */

let gitTimer = null;
function scheduleGitRefresh(delay = 600) {
  clearTimeout(gitTimer);
  gitTimer = setTimeout(refreshGit, delay);
}

// section id → number of changed blocks in its scope (itself + content
// up to the next section of any level) — drives the outline markers
function computeSectionChanges() {
  const counts = new Map();
  if (!state.doc) return counts;
  let cur = null;
  for (const b of state.doc.blocks) {
    if (b.type === 'section') cur = b.id;
    if (cur !== null && state.gitChanged.has(b.id)) {
      counts.set(cur, (counts.get(cur) || 0) + 1);
    }
  }
  return counts;
}

function applyOutlineGitMarks() {
  if (!state.doc) return;
  const counts = computeSectionChanges();
  document.querySelectorAll('#outline .oitem').forEach(item => {
    const c = counts.get(item.dataset.block) || 0;
    item.classList.toggle('git-changed', c > 0);
    let badge = item.querySelector('.ochanges');
    if (c > 0) {
      if (badge) badge.textContent = String(c);
      else item.append(el('span', 'ochanges', String(c)));
    } else if (badge) badge.remove();
  });
}

// toggle the git-change class on the blocks already in the DOM — avoids a
// full content re-render (and scroll jump) whenever only highlighting changes
function applyGitHighlights() {
  document.querySelectorAll('#content .block').forEach(n => {
    n.classList.toggle('git-change', state.gitHl && state.gitChanged.has(n.dataset.id));
  });
}

async function fetchGitChanges() {
  try {
    const ch = await papi('/git/changes');
    state.gitChanged = new Set(ch.ids);
  } catch (e) { /* status panel still works; highlighting stays as-is */ }
  try { state.gitDiff = await papi('/git/blockdiffs'); }
  catch (e) { state.gitDiff = {diffs: {}, ghosts: []}; }
}

async function refreshGit() {
  if (!state.project) {
    state.git = null;
    state.gitChanged = new Set();
    renderGit();
    return;
  }
  try {
    state.git = await papi('/git/status');
    if (state.git.repo) {
      await fetchGitChanges();
    } else {
      state.gitChanged = new Set();
      state.gitDiff = {diffs: {}, ghosts: []};
    }
  } catch (e) {
    return; // git hiccups shouldn't nag on every save
  }
  renderGit();
  applyGitHighlights();
  applyOutlineGitMarks();
  // inline diff marks and ghosts live in the rendered blocks — re-render
  // when the diff set actually changed (not on every status refresh)
  const sig = state.gitChanged.size + ':' + Object.keys(state.gitDiff.diffs).join(',');
  if (sig !== state._gitDiffSig) {
    state._gitDiffSig = sig;
    rerenderContentPreservingScroll();
  }
}

function toggleGitHl() {
  state.gitHl = !state.gitHl;
  applyGitHighlights();
  renderGit();
}

function toggleDiffOnly() {
  state.gitShowDiff = !state.gitShowDiff;
  // preserve the reading position across the re-render
  const content = $('#content');
  const firstVisible = [...document.querySelectorAll('.block')]
    .find(n => n.getBoundingClientRect().bottom > 0);
  const anchorId = firstVisible ? firstVisible.dataset.id : null;
  const prevOffset = anchorId
    ? (document.querySelector(`.block[data-id="${anchorId}"]`) || {}).offsetTop : 0;
  renderContent();
  renderGit();
  if (anchorId) {
    const n = document.querySelector(`.block[data-id="${anchorId}"]`);
    if (n) content.scrollTop += n.offsetTop - prevOffset;
  }
}

function renderGit() {
  const panel = $('#gitpanel');
  panel.innerHTML = '';
  $('#gitHead').classList.toggle('hidden', !state.project);
  if (!state.project) return;
  const g = state.git;
  if (!g) {
    panel.append(el('div', 'gitmuted', 'checking…'));
    return;
  }
  if (!g.repo) {
    panel.append(el('div', 'gitmuted', 'Not a git repository.'));
    const btn = el('button', 'edbtn gitinit', 'Initialize repository');
    btn.onclick = gitInit;
    panel.append(btn);
    return;
  }

  // header: branch + ahead/behind + manual refresh
  const head = el('div', 'githead');
  head.append(el('span', 'gitbranch', '⎇ ' + (g.branch || 'HEAD')));
  if (g.ahead || g.behind) {
    head.append(el('span', 'gitsync',
      (g.ahead ? `↑${g.ahead}` : '') + (g.behind ? `↓${g.behind}` : '')));
  }
  head.append(el('span', 'spacer'));
  const refresh = el('button', 'gbtn', '↻');
  refresh.title = 'Refresh git status';
  refresh.onclick = () => refreshGit();
  head.append(refresh);
  panel.append(head);

  // view toggles
  const views = el('div', 'gitviews');
  const hlBtn = el('button', 'gtoggle' + (state.gitHl ? ' on' : ''), 'Highlight changes');
  hlBtn.onclick = toggleGitHl;
  const diffBtn = el('button', 'gtoggle' + (state.gitShowDiff ? ' on' : ''), 'Only diff');
  diffBtn.onclick = toggleDiffOnly;
  views.append(hlBtn, diffBtn);
  panel.append(views);

  if (g.staged.length) panel.append(gitFileGroup('Staged changes', g.staged, 'staged'));
  if (g.unstaged.length) panel.append(gitFileGroup('Changes', g.unstaged, 'unstaged'));
  if (g.untracked.length) panel.append(gitFileGroup('Untracked', g.untracked, 'untracked'));
  if (!g.staged.length && !g.unstaged.length && !g.untracked.length) {
    panel.append(el('div', 'gitmuted', 'Working tree clean ✓'));
  }

  // commit helper (VS Code style): message box + commit/push
  const ta = el('textarea', 'gitmsg');
  ta.placeholder = 'Commit message (Ctrl+Enter to commit on all files)';
  ta.rows = 3;
  const bar = el('div', 'gitbar');
  const commitBtn = el('button', 'edbtn primary', '✓ Commit');
  const pushBtn = el('button', 'edbtn', '⇅ Push');
  if (!g.has_remote) {
    pushBtn.disabled = true;
    pushBtn.title = 'No remote configured — add one with:\ngit remote add origin <url>';
  }
  commitBtn.onclick = () => gitCommit(ta);
  pushBtn.onclick = gitPush;
  bar.append(commitBtn, pushBtn);
  panel.append(ta, bar);
  ta.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      gitCommit(ta);
    }
  });
}

function gitFileGroup(title, paths, kind) {
  const wrap = el('div', 'gitgroup');
  wrap.append(el('div', 'gitgrouphead', `${title} (${paths.length})`));
  for (const p of paths) {
    const row = el('div', 'gitrow');
    const name = el('span', 'gitpath', esc(p));
    name.title = p;
    row.append(name);
    const mk = (label, tip, fn) => {
      const b = el('button', 'gbtn', label);
      b.title = tip;
      b.onclick = ev => { ev.stopPropagation(); fn(); };
      return b;
    };
    if (kind === 'staged') {
      row.append(mk('⧉', 'View diff', () => openGitDiff(p, true)));
      row.append(mk('−', 'Unstage', () => gitPaths('unstage', [p])));
    } else {
      row.append(mk('⧉', 'View diff', () => openGitDiff(p, false)));
      if (kind === 'unstaged') row.append(mk('↩', 'Discard changes', () => gitDiscard(p)));
      row.append(mk('+', 'Stage', () => gitPaths('stage', [p])));
    }
    wrap.append(row);
  }
  return wrap;
}

// stage / unstage are safe ops — refresh straight from the response
async function gitPaths(op, paths) {
  try {
    const res = await ppost(`/git/${op}`, {paths});
    state.git = res.status;
    await fetchGitChanges();
    renderGit();
    applyGitHighlights();
    applyOutlineGitMarks();
  } catch (e) { toast(`Git ${op} failed: ` + e.message, true); }
}

async function gitDiscard(p) {
  if (!confirm(`Discard all uncommitted changes in "${p}"?\nThis cannot be undone.`)) return;
  try {
    const res = await ppost('/git/discard', {paths: [p]});
    state.git = res.status;
    await fetchGitChanges();
    renderGit();
    applyGitHighlights();
    applyOutlineGitMarks();
    refreshDoc(); // the worktree changed underneath us
  } catch (e) { toast('Discard failed: ' + e.message, true); }
}

async function gitCommit(ta) {
  const msg = ta.value.trim();
  if (!msg) { toast('Enter a commit message first', true); ta.focus(); return; }
  const g = state.git;
  let paths = null;
  if (g && !g.staged.length) {
    if (!g.unstaged.length && !g.untracked.length) { toast('Nothing to commit'); return; }
    if (!confirm('Nothing is staged — stage all changes and commit?')) return;
    paths = [...g.unstaged, ...g.untracked];
  }
  try {
    const res = await ppost('/git/commit', {message: msg, paths});
    state.git = res.status;
    ta.value = '';
    await fetchGitChanges();
    renderGit();
    applyGitHighlights();
    applyOutlineGitMarks();
    toast('Committed: ' + res.summary);
  } catch (e) { toast('Commit failed: ' + e.message, true); }
}

async function gitPush() {
  try {
    const res = await ppost('/git/push', {});
    state.git = res.status;
    renderGit();
    toast('Pushed to remote');
  } catch (e) {
    let msg = 'Push failed: ' + e.message;
    if (/no upstream/i.test(e.message) && state.git && state.git.branch) {
      msg += ` — run: git push -u origin ${state.git.branch}`;
    }
    toast(msg, true);
  }
}

async function gitInit() {
  try {
    const res = await ppost('/git/init', {});
    state.git = res.status;
    await fetchGitChanges();
    renderGit();
    applyGitHighlights();
    applyOutlineGitMarks();
    toast('Git repository initialized');
  } catch (e) { toast('git init failed: ' + e.message, true); }
}

// unified diff → colored lines; spans are display:block so backgrounds
// cover the full line width
function renderDiffText(text) {
  if (!text || !text.trim()) return '<span class="d-none">No differences.</span>';
  return text.split('\n').map(line => {
    const t = esc(line) || '&nbsp;';
    if (line.startsWith('@@')) return `<span class="d-hunk">${t}</span>`;
    if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="d-add">${t}</span>`;
    if (line.startsWith('-') && !line.startsWith('---')) return `<span class="d-del">${t}</span>`;
    if (line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ')) {
      return `<span class="d-meta">${t}</span>`;
    }
    return `<span>${t}</span>`;
  }).join('');
}

async function openGitDiff(path, staged = false) {
  const modal = $('#gitmodal');
  modal.classList.remove('hidden');
  modal.innerHTML = '';
  const wrap = el('div', 'gitdiffwrap');
  wrap.append(el('h3', '', (staged ? 'Staged changes — ' : 'Changes — ') + esc(path)));
  const pre = el('pre', 'gitdiffpre', 'loading…');
  wrap.append(pre);
  const bar = el('div', 'edbar');
  const closeBtn = el('button', 'edbtn', 'Close');
  bar.append(el('span', 'spacer'), closeBtn);
  wrap.append(bar);
  modal.append(wrap);

  const escClose = ev => { if (ev.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', escClose, true);
    modal.classList.add('hidden');
    modal.innerHTML = '';
  };
  document.addEventListener('keydown', escClose, true);
  closeBtn.onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  try {
    const res = await papi(`/git/diff?path=${encodeURIComponent(path)}&staged=${staged ? 1 : 0}`);
    pre.innerHTML = renderDiffText(res.text);
  } catch (e) {
    pre.textContent = 'Failed to load diff: ' + e.message;
  }
}

/* ------------------------------------------------------------------ */
/* proofreading: panel, squiggles, apply suggestion                    */
/* ------------------------------------------------------------------ */

function proofLang() {
  return localStorage.getItem('proof-lang') || 'en-US';
}

// issue text is snapshotted at check time so a stale issue (block edited
// since) can be detected before any rewrite is attempted
function pruneProofIssues(doc) {
  if (!state.proof.issues.length) return;
  const byId = new Map(doc.blocks.map(b => [b.id, b]));
  state.proof.issues = state.proof.issues.filter(i => {
    const b = byId.get(i.block_id);
    return b && b.source.slice(i.start, i.end) === i.text;
  });
}

// parsed bibliography for citation resolution — refreshed on load, project
// switch and after each compile (the .bbl changes there)
async function refreshBib() {
  if (!state.project) { state.bib = null; return; }
  try {
    const res = await papi('/bibliography');
    state.bib = res.available ? res : null;
  } catch (e) { state.bib = null; }
  if (state.doc) rerenderContentPreservingScroll();
}

async function loadProofConfig() {
  if (!state.project) { state.proof.config = null; renderProof(); return; }
  try { state.proof.config = await papi('/proof/config'); }
  catch (e) {
    state.proof.config = {engine: '?', available: false, error: e.message};
  }
  renderProof();
  // background check when the app (or a project) is opened
  if (state.proof.config.available && !state.proof.checked &&
      !state.proof.checking) {
    checkDocument();
  }
}

function renderProof() {
  const panel = $('#proofpanel');
  panel.innerHTML = '';
  $('#proofHead').classList.toggle('hidden', !state.project);
  if (!state.project) return;
  const p = state.proof;

  // controls: language + manual check
  const bar = el('div', 'proofbar');
  const sel = el('select', 'prooflang');
  for (const [code, label] of [['en-US', 'English'], ['de-DE', 'Deutsch']]) {
    const o = el('option', '', label);
    o.value = code;
    if (code === proofLang()) o.selected = true;
    sel.append(o);
  }
  sel.title = 'Language for the proofreading check';
  sel.onchange = () => {
    localStorage.setItem('proof-lang', sel.value);
    state.proof.issues = []; // results are language-specific
    state.proof.checked = false;
    renderProof();
    rerenderContentPreservingScroll();
  };
  const btn = el('button', 'edbtn primary proofcheck',
    p.checking ? 'checking…' : 'Check document');
  btn.disabled = p.checking;
  btn.onclick = checkDocument;
  bar.append(sel, btn);
  panel.append(bar);

  if (p.config && !p.config.available) {
    panel.append(el('div', 'pferrbox',
      esc(p.config.error || 'proofreading engine unavailable')));
  }

  if (!p.issues.length) {
    if (p.checked) panel.append(el('div', 'gitmuted', 'No issues found ✓'));
    return;
  }
  panel.append(el('div', 'gitmuted',
    `${p.issues.length} issue${p.issues.length === 1 ? '' : 's'}`));
  // rows in document order
  const order = new Map(state.doc.blocks.map((b, ix) => [b.id, ix]));
  const sorted = [...p.issues].sort((a, b) =>
    (order.get(a.block_id) ?? 1e9) - (order.get(b.block_id) ?? 1e9) ||
    a.start - b.start);
  for (const it of sorted) panel.append(proofRow(it));
}

function proofRow(it) {
  const row = el('div', 'pfrow');
  row.title = it.file + ' — click to jump to the word';
  row.onclick = () => gotoIssue(it);
  const top = el('div', 'pfrowtop');
  top.append(el('span', 'pfbadge pf-' + esc(it.category || 'grammar'),
    esc(it.category || 'grammar')));
  const word = (it.text || '').replace(/\s+/g, ' ').trim();
  if (word) top.append(el('span', 'pfword', '“' + esc(word) + '”'));
  top.append(el('span', 'spacer'));
  const isMisspell = it.category === 'misspelling' || it.category === 'typo';
  if (isMisspell && it.text) {
    const dict = el('button', 'gbtn', '＋');
    dict.title = `Add “${it.text.trim()}” to the project dictionary`;
    dict.onclick = ev => { ev.stopPropagation(); addToDictionary(it); };
    top.append(dict);
  }
  const x = el('button', 'gbtn', '✕');
  x.title = 'Ignore this case for this project (persisted)';
  x.onclick = ev => {
    ev.stopPropagation();
    ignoreIssue(it);
  };
  top.append(x);
  row.append(top);
  // reason below the kind + word
  const msg = el('div', 'pfmsg', esc(it.message));
  msg.title = it.message; // full text even if the row grows tall
  row.append(msg);
  if (it.replacements && it.replacements.length) {
    const sugg = el('div', 'pfsugg');
    for (const r of it.replacements.slice(0, 4)) {
      const chip = el('button', 'pfchip', esc(r));
      chip.title = 'Replace with “' + r + '”';
      chip.onclick = ev => { ev.stopPropagation(); applyProofFix(it, r); };
      sugg.append(chip);
    }
    row.append(sugg);
  }
  return row;
}

// the rendered squiggle span of an issue (matched by flagged text)
function issueSpanEl(it) {
  const node = $(`.block[data-id="${it.block_id}"]`);
  if (!node) return null;
  const word = (it.text || '').replace(/\s+/g, ' ').trim();
  if (!word) return null;
  return [...node.querySelectorAll('.pf-err')]
    .find(s => (s.textContent || '').replace(/\s+/g, ' ').trim() === word) || null;
}

// jump to an issue: scroll only when the word is off-screen, then flash it
function gotoIssue(it) {
  const span = issueSpanEl(it);
  const target = span || $(`.block[data-id="${it.block_id}"]`);
  if (!target) return;
  const r = target.getBoundingClientRect();
  const visible = r.top >= 0 && r.bottom <= window.innerHeight;
  if (!visible) target.scrollIntoView({behavior: 'smooth', block: 'center'});
  setTimeout(() => flashIssueWord(it), visible ? 0 : 650);
}

// briefly highlight the flagged word itself, not the whole paragraph;
// falls back to the block when the word span isn't rendered (e.g. exotic
// table content that the preview reconstructs)
function flashIssueWord(it) {
  let target = issueSpanEl(it);
  if (!target) target = $(`.block[data-id="${it.block_id}"]`);
  if (!target) return;
  target.classList.remove('pf-flash');
  void target.offsetWidth; // restart the animation if it is already running
  target.classList.add('pf-flash');
  setTimeout(() => target.classList.remove('pf-flash'), 2600);
}

function dropProofIssue(issue) {
  state.proof.issues = state.proof.issues.filter(o => o !== issue);
  renderProof();
  rerenderContentPreservingScroll();
}

// re-render the content area without losing the reading position
function rerenderContentPreservingScroll() {
  const content = $('#content');
  const firstVisible = [...document.querySelectorAll('.block')]
    .find(n => n.getBoundingClientRect().bottom > 0);
  const anchorId = firstVisible ? firstVisible.dataset.id : null;
  const prevOffset = anchorId
    ? (document.querySelector(`.block[data-id="${anchorId}"]`) || {}).offsetTop : 0;
  renderContent();
  if (anchorId) {
    const n = document.querySelector(`.block[data-id="${anchorId}"]`);
    if (n) content.scrollTop += n.offsetTop - prevOffset;
  }
}

async function checkDocument() {
  if (!state.project || state.proof.checking) return;
  const pid = state.project;
  const doc = state.doc; // map onto the doc the check was started with
  if (!doc) return;
  state.proof.checking = true;
  renderProof();
  try {
    const res = await ppost('/proof/check', {lang: proofLang()});
    if (state.project !== pid) return; // switched projects mid-check
    // snapshot the flagged text so staleness can be detected later
    const byId = new Map(doc.blocks.map(b => [b.id, b]));
    for (const i of res.issues) {
      const b = byId.get(i.block_id);
      i.text = b ? b.source.slice(i.start, i.end) : '';
    }
    state.proof.issues = mergeIssues([], res.issues);
    state.proof.checked = true;
  } catch (e) {
    toast('Check failed: ' + e.message, true);
  } finally {
    state.proof.checking = false;
    renderProof();
    rerenderContentPreservingScroll();
  }
}

// re-check only the given blocks (after an edit) and merge into the results
async function checkBlocks(ids) {
  if (!state.project || !ids || !ids.length) return;
  const pid = state.project;
  const doc = state.doc;
  if (!doc) return;
  try {
    const res = await ppost('/proof/check',
      {lang: proofLang(), block_ids: ids});
    if (state.project !== pid) return; // switched projects mid-check
    const byId = new Map(doc.blocks.map(b => [b.id, b]));
    for (const i of res.issues) {
      const b = byId.get(i.block_id);
      i.text = b ? b.source.slice(i.start, i.end) : '';
    }
    const idset = new Set(ids);
    const kept = state.proof.issues.filter(i => !idset.has(i.block_id));
    state.proof.issues = mergeIssues(kept, res.issues);
    state.proof.checked = true;
    renderProof();
    rerenderContentPreservingScroll();
  } catch (e) { /* background re-check: stay quiet */ }
}

// combine issue lists and sort in document order; dictionary words and
// persisted ignored cases are already filtered server-side
function mergeIssues(base, extra) {
  const all = [...base, ...extra];
  const order = new Map(state.doc.blocks.map((b, ix) => [b.id, ix]));
  return all.sort((a, b) =>
    (order.get(a.block_id) ?? 1e9) - (order.get(b.block_id) ?? 1e9) ||
    a.start - b.start);
}

// ignore key is text-based so it survives offset shifts within a block
function ignoreKey(it) {
  return it.rule_id + '\u0000' + (it.text || '').replace(/\s+/g, ' ').trim();
}

// persist one ignored case (rule + flagged text) for this project
async function ignoreIssue(issue) {
  try {
    await ppost('/proof/ignore',
      {rule: issue.rule_id, text: (issue.text || '').trim()});
    const key = ignoreKey(issue);
    state.proof.issues = state.proof.issues.filter(i => ignoreKey(i) !== key);
    renderProof();
    rerenderContentPreservingScroll();
    toast('Case ignored for this project — it will not come back on re-checks');
  } catch (e) {
    toast('Ignore failed: ' + e.message, true);
  }
}

// persist a word for this project and drop every issue for it
async function addToDictionary(issue) {
  const word = (issue.text || '').replace(/\s+/g, ' ').trim();
  if (!word) return;
  try {
    await ppost('/proof/dictionary', {word});
    const w = word.toLowerCase();
    state.proof.issues = state.proof.issues.filter(i =>
      (i.text || '').replace(/\s+/g, ' ').trim().toLowerCase() !== w);
    renderProof();
    rerenderContentPreservingScroll();
    toast(`“${word}” added to the project dictionary`);
  } catch (e) {
    toast('Failed to add word: ' + e.message, true);
  }
}

/* ---- hover popup on squiggled words ---- */

let pfPopup = null;
let pfHideTimer = null;

function hideProofPopup() {
  clearTimeout(pfHideTimer);
  if (pfPopup) { pfPopup.remove(); pfPopup = null; }
}

function showProofPopup(span) {
  const blockEl = span.closest('.block');
  const word = (span.textContent || '').replace(/\s+/g, ' ').trim();
  if (!blockEl || !word) return;
  const issue = state.proof.issues.find(i =>
    i.block_id === blockEl.dataset.id &&
    (i.text || '').replace(/\s+/g, ' ').trim() === word);
  if (!issue) return;
  hideProofPopup();
  const pop = el('div', 'pfpopup');
  const head = el('div', 'pfpopuphead');
  head.append(el('span', 'pfbadge pf-' + esc(issue.category || 'grammar'),
    esc(issue.category || 'grammar')));
  const x = el('button', 'gbtn', '✕');
  x.title = 'Close';
  x.onclick = hideProofPopup;
  head.append(el('span', 'spacer'), x);
  pop.append(head);
  pop.append(el('div', 'pfpopupmsg', esc(issue.message)));
  if (issue.replacements && issue.replacements.length) {
    const sugg = el('div', 'pfsugg');
    for (const r of issue.replacements.slice(0, 5)) {
      const chip = el('button', 'pfchip', esc(r));
      chip.title = 'Replace with “' + r + '”';
      chip.onclick = () => { hideProofPopup(); applyProofFix(issue, r); };
      sugg.append(chip);
    }
    pop.append(sugg);
  }
  if (issue.category === 'misspelling' || issue.category === 'typo') {
    const dict = el('button', 'pfdict', `＋ Add “${word}” to dictionary`);
    dict.onclick = () => { hideProofPopup(); addToDictionary(issue); };
    pop.append(dict);
  }
  const ign = el('button', 'pfdict', '✕ Ignore this case');
  ign.title = 'Persisted for this project — re-checks will not report it again';
  ign.onclick = () => { hideProofPopup(); ignoreIssue(issue); };
  pop.append(ign);
  document.body.append(pop);
  // place below the squiggled span, clamped to the viewport
  const r = span.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.left + window.scrollX;
  let top = r.bottom + window.scrollY + 4;
  if (left + pw > window.scrollX + document.documentElement.clientWidth - 8) {
    left = window.scrollX + document.documentElement.clientWidth - pw - 8;
  }
  if (top + ph > window.scrollY + window.innerHeight &&
      r.top - ph > 0) {
    top = r.top + window.scrollY - ph - 4; // flip above when near the bottom
  }
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  pfPopup = pop;
}

function showCitePopup(span) {
  const keys = (span.dataset.keys || '').split(',').map(s => s.trim()).filter(Boolean);
  const bib = state.bib;
  if (!bib || !bib.available || !keys.length) return;
  const byKey = new Map(bib.entries.map(e => [e.key, e]));
  hideProofPopup();
  const pop = el('div', 'pfpopup citepopup');
  const head = el('div', 'pfpopuphead');
  head.append(el('span', 'pfbadge', 'reference' +
    (keys.length > 1 ? 's' : '')));
  head.append(el('span', 'spacer'));
  const x = el('button', 'gbtn', '✕');
  x.title = 'Close';
  x.onclick = hideProofPopup;
  head.append(x);
  pop.append(head);
  let shown = 0;
  for (const k of keys) {
    const e = byKey.get(k);
    if (!e) continue;
    shown++;
    const item = el('div', 'citeitem');
    item.append(el('div', 'citekey', bib.style === 'numeric'
      ? '[' + e.num + '] ' + esc(k) : esc(k)));
    item.append(el('div', 'citetext', esc(e.plain)));
    if (e.url && /^https?:/i.test(e.url)) {
      const link = el('a', 'citelink', 'Open paper ↗');
      link.href = e.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = e.url;
      link.onclick = ev => ev.stopPropagation();
      item.append(link);
    }
    pop.append(item);
  }
  if (!shown) return;
  document.body.append(pop);
  // same placement as the proof popup: below the span, clamped, flipped up
  const r = span.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.left + window.scrollX;
  let top = r.bottom + window.scrollY + 4;
  if (left + pw > window.scrollX + document.documentElement.clientWidth - 8) {
    left = window.scrollX + document.documentElement.clientWidth - pw - 8;
  }
  if (top + ph > window.scrollY + window.innerHeight && r.top - ph > 0) {
    top = r.top + window.scrollY - ph - 4;
  }
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  pfPopup = pop;
}

function initProofHover() {
  document.addEventListener('mouseover', ev => {
    const cite = ev.target.closest && ev.target.closest('.citeref');
    if (cite) {
      clearTimeout(pfHideTimer);
      showCitePopup(cite);
      return;
    }
    const span = ev.target.closest && ev.target.closest('.pf-err');
    if (span) {
      clearTimeout(pfHideTimer);
      showProofPopup(span);
    } else if (pfPopup && !(ev.target.closest && ev.target.closest('.pfpopup'))) {
      // small grace period so the short hop to the popup doesn't close it
      clearTimeout(pfHideTimer);
      pfHideTimer = setTimeout(hideProofPopup, 450);
    } else if (pfPopup) {
      clearTimeout(pfHideTimer); // pointer is on the popup
    }
  });
  document.addEventListener('scroll', () => {
    if (pfPopup) hideProofPopup();
  }, true);
  window.addEventListener('resize', hideProofPopup);
}

async function applyProofFix(issue, replacement) {
  const b = state.doc ? state.doc.blocks.find(x => x.id === issue.block_id) : null;
  if (!b) { toast('Block no longer exists — re-check first', true); return; }
  if (b.source.slice(issue.start, issue.end) !== issue.text) {
    toast('Text changed since the check — re-check first', true);
    dropProofIssue(issue);
    return;
  }
  if (state.edit && state.edit.id === issue.block_id) closeEditor();
  const newSource = b.source.slice(0, issue.start) +
    replacement + b.source.slice(issue.end);
  try {
    const res = await ppost(`/block/${issue.block_id}/save`, {source: newSource});
    applyDoc(res.doc); // also prunes stale issues and re-renders
    toast('Suggestion applied');
    checkBlocks([issue.block_id]); // re-check the fixed block
  } catch (e) { handleOpError(e, b); }
}

/* ------------------------------------------------------------------ */
/* theme: dark default, persisted light/dark switch                    */
/* ------------------------------------------------------------------ */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('theme', t);
  const btn = $('#themebtn');
  if (btn) {
    btn.textContent = t === 'dark' ? '☀' : '🌙';
    btn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
}

/* ------------------------------------------------------------------ */
/* undo / redo of document changes (server-side snapshot history)      */
/* ------------------------------------------------------------------ */

function syncHistoryButtons() {
  const h = state.history;
  const ub = $('#undobtn'), rb = $('#redobtn');
  ub.disabled = !state.project || !h.can_undo;
  rb.disabled = !state.project || !h.can_redo;
  ub.title = h.can_undo ? `Undo ${h.undo_label || 'change'} (Ctrl+Z)`
    : 'Undo last change (Ctrl+Z)';
  rb.title = h.can_redo ? `Redo ${h.redo_label || 'change'} (Ctrl+Shift+Z or Ctrl+Y)`
    : 'Redo (Ctrl+Shift+Z or Ctrl+Y)';
}

async function refreshHistory() {
  if (!state.project) {
    state.history = {can_undo: false, can_redo: false};
  } else {
    try { state.history = await papi('/history'); }
    catch (e) { return; /* keep last known state */ }
  }
  syncHistoryButtons();
}

async function doUndo() {
  if (!state.project) return;
  try {
    const res = await ppost('/undo', {});
    state.history = res;
    syncHistoryButtons();
    if (res.noop) { toast('Nothing to undo'); return; }
    applyDoc(res.doc);
    toast('Undone: ' + res.label);
  } catch (e) { toast('Undo failed: ' + e.message, true); }
}

async function doRedo() {
  if (!state.project) return;
  try {
    const res = await ppost('/redo', {});
    state.history = res;
    syncHistoryButtons();
    if (res.noop) { toast('Nothing to redo'); return; }
    applyDoc(res.doc);
    toast('Redone: ' + res.label);
  } catch (e) { toast('Redo failed: ' + e.message, true); }
}

// Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y — but only outside text fields, where the
// browser's native text undo must keep working
document.addEventListener('keydown', ev => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
  const k = (ev.key || '').toLowerCase();
  const isUndo = k === 'z' && !ev.shiftKey;
  const isRedo = (k === 'z' && ev.shiftKey) || k === 'y';
  if (!isUndo && !isRedo) return;
  const t = ev.target;
  if (t && (t.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT', 'MATH-FIELD'].includes(t.tagName))) {
    return;
  }
  ev.preventDefault();
  isUndo ? doUndo() : doRedo();
});

/* ------------------------------------------------------------------ */
/* doc lifecycle: apply + websocket live reload                        */
/* ------------------------------------------------------------------ */

// highlight keys: project + file + source — a block stays highlighted until
// *it* is edited (its key changes), even across other saves and reloads
function blockKey(b) {
  return `${state.project}\u0000${b.file}\u0000${b.source}`;
}

// keys of blocks whose content differs from the previously known doc
function diffKeys(oldDoc, newDoc) {
  const changed = new Set();
  if (!oldDoc) return changed;
  const oldKeys = new Map();
  for (const b of oldDoc.blocks) {
    const k = b.file + '\u0000' + b.source;
    oldKeys.set(k, (oldKeys.get(k) || 0) + 1);
  }
  for (const b of newDoc.blocks) {
    const k = b.file + '\u0000' + b.source;
    const n = oldKeys.get(k) || 0;
    if (n > 0) oldKeys.set(k, n - 1);
    else changed.add(blockKey(b));
  }
  return changed;
}

function updateHighlights(doc, fromDisk) {
  const present = new Set(doc.blocks.map(blockKey));
  let keys = state.diskKeys ? [...state.diskKeys].filter(k => present.has(k)) : [];
  if (fromDisk) keys = keys.concat([...diffKeys(state.doc, doc)]);
  state.diskKeys = new Set(keys);
}

function applyDoc(doc, fromDisk = false) {
  updateHighlights(doc, fromDisk);
  // keep an open editor alive if its block still exists unchanged on disk
  let keep = null;
  if (state.edit) {
    const match = doc.blocks.find(x =>
      x.file === state.edit.block.file &&
      x.source === state.edit.original &&
      x.type === state.edit.block.type);
    if (match) keep = match;
  }
  const firstVisible = [...document.querySelectorAll('.block')]
    .find(n => n.getBoundingClientRect().bottom > 0);
  const anchorId = keep ? keep.id : (firstVisible ? firstVisible.dataset.id : null);
  const content = $('#content');
  const prevOffset = anchorId
    ? (document.querySelector(`.block[data-id="${anchorId}"]`) || {}).offsetTop
    : 0;

  state.doc = doc;
  pruneProofIssues(doc); // drop issues whose block text changed
  renderAll();

  if (keep) {
    state.edit.id = keep.id;
    state.edit.block = keep;
    const node = $(`.block[data-id="${keep.id}"]`);
    if (node) {
      node.classList.add('editing');
      node.querySelector('.bcontent').replaceWith(state.edit.root.root);
    }
  } else if (state.edit) {
    banner('The document changed on disk. Your open edit could not be matched ' +
      'to the new content — saving it may conflict.');
    const node = $(`.block[data-id="${state.edit.id}"]`);
    if (node) node.classList.add('stale');
  }
  if (anchorId) {
    const n = document.querySelector(`.block[data-id="${anchorId}"]`);
    if (n) content.scrollTop += n.offsetTop - prevOffset;
  }
  // saves and external reloads both change what git sees — debounce so a
  // burst of saves doesn't fire a git subprocess per keystroke
  scheduleGitRefresh();
  refreshHistory(); // cheap in-memory flags — keep undo/redo current
}

async function refreshDoc() {
  if (!state.project) { renderAll(); return; }
  try { applyDoc(await papi('/doc')); }
  catch (e) { toast('Cannot load document: ' + e.message, true); }
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => setConn(true);
  ws.onclose = () => {
    setConn(false);
    setTimeout(connectWS, 2000);
  };
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'reload' && msg.project === state.project) applyDoc(msg.doc, true);
  };
}

function setConn(on) {
  const c = $('#conn');
  c.textContent = on ? '● live' : '○ reconnecting…';
  c.classList.toggle('conn-on', on);
  c.classList.toggle('conn-off', !on);
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

// MathLive virtual keyboard: reserve space for it and keep the equation
// in view — driven by every geometry signal MathLive offers, plus a short
// poll after editor open, so animation/late-layout can't miss it
function wireMathKeyboard() {
  if (window._kbWired || !window.mathVirtualKeyboard) return;
  window._kbWired = true;
  const keyboardHeight = () => {
    const vk = window.mathVirtualKeyboard;
    if (!vk || !vk.visible) return 0;
    if (vk.boundingRect && vk.boundingRect.height > 0) return vk.boundingRect.height;
    if (typeof vk.height === 'number' && vk.height > 0) return vk.height;
    return 0;
  };
  const syncKeyboardSpace = () => {
    const h = keyboardHeight();
    const content = $('#content');
    content.style.paddingBottom = h > 0 ? (h + 24) + 'px' : '';
    if (h > 0 && state.edit) {
      const mf = state.edit.root.root.querySelector('math-field');
      if (mf && mf.offsetParent !== null) {
        mf.scrollIntoView({block: 'center', behavior: 'smooth'});
      }
    }
  };
  ['geometrychange', 'virtual-keyboard-toggle'].forEach(evName => {
    try { window.mathVirtualKeyboard.addEventListener(evName, syncKeyboardSpace); }
    catch (e) { /* older MathLive without this event */ }
  });
  window._syncKeyboardSpace = syncKeyboardSpace;
}

// CDN math libs load async — once KaTeX arrives, math blocks rendered in
// the meantime need one re-render; MathLive's custom element upgrades itself
function watchMathLibs() {
  let katexApplied = typeof katex !== 'undefined';
  let mlWired = !!customElements.get('math-field');
  if (katexApplied && mlWired) return;
  const libWait = setInterval(() => {
    if (!katexApplied && typeof katex !== 'undefined') {
      katexApplied = true;
      if (state.doc) renderAll();
    }
    if (!mlWired && customElements.get('math-field')) {
      mlWired = true;
      wireMathKeyboard();
    }
    if (katexApplied && mlWired) clearInterval(libWait);
  }, 250);
  setTimeout(() => clearInterval(libWait), 30000);
}

// connect the live socket first — the status pill must not wait for
// project loading or CDN math libs
connectWS();

(async () => {
  $('#projadd').addEventListener('click', addProject);
  wireMathKeyboard();
  // collapsible sidebar groups (remembered across sessions)
  const setupToggle = (headId, listId, key) => {
    const head = document.getElementById(headId);
    const list = document.getElementById(listId);
    const apply = c => {
      list.classList.toggle('sb-collapsed', c);
      head.classList.toggle('collapsed', c);
    };
    apply(localStorage.getItem(key) === '1');
    head.addEventListener('click', ev => {
      // a button inside the head (e.g. ＋ add project) must not toggle
      if (ev.target.closest && ev.target.closest('button')) return;
      const c = !list.classList.contains('sb-collapsed');
      localStorage.setItem(key, c ? '1' : '0');
      apply(c);
    });
  };
  setupToggle('projHead', 'projlist', 'sb-project-collapsed');
  setupToggle('filesHead', 'filelist', 'sb-files-collapsed');
  setupToggle('outlineHead', 'outline', 'sb-outline-collapsed');
  setupToggle('gitHead', 'gitpanel', 'sb-git-collapsed');
  setupToggle('proofHead', 'proofpanel', 'sb-proof-collapsed');
  // track reading position for the outline highlight
  let scrollTimer = null;
  $('#content').addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(updateOutlineCurrent, 120);
  });
  try {
    state.projects = await api('/api/projects');
  } catch (e) { /* server error shown via refresh */ }
  await refreshProjects();
  refreshGit();
  loadProofConfig();
  refreshBib();
  initProofHover();
  watchMathLibs();
  $('#undobtn').addEventListener('click', doUndo);
  $('#redobtn').addEventListener('click', doRedo);
  $('#themebtn').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  applyTheme(localStorage.getItem('theme') || 'dark');
  syncHistoryButtons();
})();
