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
      if (!depth) return {body: s.slice(i + 1, j), end: j + 1};
    }
  }
  return null;
}

function katexSpan(tex, display) {
  if (typeof katex === 'undefined') return `<code class="kerr">${esc(tex)}</code>`;
  try {
    return katex.renderToString(tex, {displayMode: display, throwOnError: true});
  } catch (e) {
    try {
      return katex.renderToString(tex, {displayMode: display, throwOnError: false});
    } catch (e2) {
      return `<code class="kerr">${esc(tex)}</code>`;
    }
  }
}

function renderInline(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
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
            out += `<sup class="fn" title="footnote">${renderInline(g.body)}</sup>`;
          } else if (['ref', 'eqref', 'cite', 'label'].includes(cmd)) {
            out += `<span class="chip">${cmd}:${esc(g.body)}</span>`;
          } else if (cmd === 'url') {
            out += `<code>${esc(g.body)}</code>`;
          } else if (cmd === 'textbf') {
            out += `<strong>${renderInline(g.body)}</strong>`;
          } else if (cmd === 'texttt') {
            out += `<code>${esc(g.body)}</code>`;
          } else if (cmd === 'underline') {
            out += `<u>${renderInline(g.body)}</u>`;
          } else { // textit, emph, text, textrm, mbox
            out += `<em>${renderInline(g.body)}</em>`;
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
          out += `<strong>${renderInline(g.body)}</strong> `;
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
      out += esc(c); i++;
    }
  }
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
  if (/\\(multicolumn|multirow|hline|cline|vline|cellcolor|toprule|midrule|bottomrule)/.test(body)) return null;
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
             .replace(/\\cline\{[^}]*\}/g, '');
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

function renderTableHTML(grid) {
  const rows = grid.map(r =>
    `<tr>${r.map(c => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('');
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
      return `<h${lv} class="blk">${chev}${num ? num + ' ' : ''}${renderInline((b.meta && b.meta.title) || '')}</h${lv}>`;
    }
    case 'paragraph':
      return `<div class="rtext">${renderInline(b.source)}</div>`;
    case 'math': {
      const labels = mathLabels(b.source);
      return `<div class="disp-math">${katexSpan(displayTex(b), true)}` +
        (labels.length ? `<div class="mathlabels">${labelChips(labels)}</div>` : '') +
        `</div>`;
    }
    case 'list': {
      const isOrd = b.meta && b.meta.env === 'enumerate';
      const items = listItems(b.source);
      const tag = isOrd ? 'ol' : 'ul';
      return `<${tag} class="rtext">${items.map(it => `<li>${renderInline(it)}</li>`).join('')}</${tag}>`;
    }
    case 'table': {
      const t = parseTabular(b.source);
      if (t) return renderTableHTML(t.grid);
      const L = parseTabularLenient(b.source);
      if (L) {
        return `<div class="tabwrap">` +
          renderTableHTML(L.grid) +
          (L.caption ? `<figcaption class="figcap">${renderInline(L.caption)}</figcaption>` : '') +
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
      return `<figure class="blkfig">${img}` +
        (caption ? `<figcaption class="figcap">${renderInline(caption)}</figcaption>` : '') +
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
  // project selector
  const sel = $('#projsel');
  sel.innerHTML = '';
  for (const p of state.projects) {
    const opt = el('option', '', esc(p.name));
    opt.value = p.id;
    if (p.id === state.project) opt.selected = true;
    sel.append(opt);
  }
  const has = !!state.project;
  $('#projdel').disabled = !has;
  $('#projcompile').disabled = !has;

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
  for (const b of state.doc.blocks) {
    if (b.type !== 'section') continue;
    const item = el('button', 'oitem');
    item.style.setProperty('--indent', ((b.meta.level || 2) - 1));
    item.dataset.block = b.id;
    const num = state.secNums.get(b.id);
    item.innerHTML = (num ? num + '&nbsp;&nbsp;' : '') + renderInline(b.meta.title || '(untitled)');
    item.onclick = () => scrollToBlock(b.id);
    ol.append(item);
  }
  updateOutlineCurrent();
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
function computeCollapsedIds() {
  const hidden = new Set();
  let hideLevel = null, rootId = null;
  for (const b of state.doc.blocks) {
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
  const c = $('#content');
  c.innerHTML = '';
  if (!state.doc) {
    c.append(el('div', 'emptystate',
      '<h2>No project open</h2><p>Click ＋ in the sidebar to open a main .tex file from disk.</p>'));
    return;
  }
  const hiddenIds = computeCollapsedIds();
  const docEl = el('div', 'doc');
  const blocks = state.doc.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const h = hiddenIds.has(b.id);
    docEl.append(blockEl(b, h));
    if (EDITABLE.has(b.type)) {
      // the insert line sits between two blocks: visible only if both are
      const nextH = i + 1 < blocks.length ? hiddenIds.has(blocks[i + 1].id) : h;
      docEl.append(insertLine(b, h || nextH));
    }
  }
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
}

function openEditor(b) {
  if (state.edit) {
    if (state.edit.id === b.id) return;
    closeEditor();
  }
  const node = $(`.block[data-id="${b.id}"]`);
  if (!node) return;

  const kind = b.type === 'math' ? 'math'
    : (b.type === 'table' && parseTabular(b.source) ? 'grid' : 'source');
  const ed = buildEditor(b, kind);
  node.classList.add('editing');
  node.querySelector('.bcontent').replaceWith(ed.root);
  state.edit = {id: b.id, kind, original: b.source, root: ed, block: b};
  // Esc always closes the open editor, whatever has focus
  state._escHandler = ev => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      ev.preventDefault();
      closeEditor();
    }
  };
  document.addEventListener('keydown', state._escHandler, true);
  ed.focus();
}

function buildEditor(b, kind) {
  const ed = {root: el('div', 'editor'), kind};
  const bar = el('div', 'edbar');
  const commitBtn = el('button', 'edbtn primary', '✓ Save');
  const cancelBtn = el('button', 'edbtn', 'Cancel');
  bar.append(cancelBtn, el('span', 'spacer'), commitBtn);
  ed.root.append(bar);

  const commit = async () => {
    const src = ed.getValue();
    if (src === state.edit.original) { closeEditor(); return; }
    const editRef = state.edit;
    if (editRef.kind === 'math') dismissMathKeyboard(editRef.root.root);
    try {
      const res = await ppost(`/block/${editRef.id}/save`, {source: src});
      state.edit = null;
      applyDoc(res.doc);
      toast('Saved');
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
  const parsed = parseTabular(b.source);
  const grid = parsed.grid.map(r => r.slice());
  const maxCols = Math.max(...grid.map(r => r.length));
  grid.forEach(r => { while (r.length < maxCols) r.push(''); });

  let sel = {r: grid.length - 1, c: maxCols - 1};

  const gtools = el('div', 'gtools');
  const mkBtn = (label, fn) => {
    const btn = el('button', 'edbtn', label);
    btn.onclick = fn;
    return btn;
  };
  gtools.append(
    mkBtn('+ Row below', () => {
      grid.splice(sel.r + 1, 0, new Array(grid[0].length).fill('')); draw();
    }),
    mkBtn('+ Col right', () => {
      grid.forEach(r => r.splice(sel.c + 1, 0, '')); draw();
    }),
    mkBtn('− Row', () => {
      if (grid.length <= 1) return;
      grid.splice(sel.r, 1);
      sel.r = Math.min(sel.r, grid.length - 1);
      draw();
    }),
    mkBtn('− Col', () => {
      if (grid[0].length <= 1) return;
      grid.forEach(r => r.splice(sel.c, 1));
      sel.c = Math.min(sel.c, grid[0].length - 1);
      draw();
    }),
  );
  bar.append(gtools);

  const tbl = el('table', 'gedit');
  ed.root.append(tbl);
  const inputs = [];

  function draw() {
    tbl.innerHTML = '';
    inputs.length = 0;
    grid.forEach((row, r) => {
      const tr = el('tr');
      if (r === sel.r) tr.classList.add('selrow');
      row.forEach((cell, c) => {
        const td = el('td');
        if (r === sel.r && c === sel.c) td.classList.add('selcol');
        const ta = el('textarea');
        ta.value = cell;
        ta.rows = 1;
        ta.addEventListener('focus', () => {
          sel = {r, c};
          tbl.querySelectorAll('.selcol,.selrow')
            .forEach(x => x.classList.remove('selcol', 'selrow'));
          td.classList.add('selcol');
          tr.classList.add('selrow');
        });
        ta.addEventListener('input', () => { grid[r][c] = ta.value; });
        ta.addEventListener('keydown', e => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
        });
        inputs.push(ta);
        td.append(ta);
        tr.append(td);
      });
      tbl.append(tr);
    });
    if (inputs[0]) inputs[0].focus();
  }
  draw();

  ed.getValue = () => {
    const body = grid.map(r => r.map(c => c.trim()).join(' & ')).join(' \\\\\n');
    return `\\begin{${parsed.env}}{${parsed.colspec}}\n${body}\n\\end{${parsed.env}}`;
  };
  ed.focus = () => inputs[0] && inputs[0].focus();
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
        body: JSON.stringify({path, source: ta.value}),
      });
      close();
      applyDoc(res.doc);
      toast('Saved ' + path);
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
  refreshDoc();
}

async function removeProject() {
  if (!state.project) return;
  const p = state.projects.find(x => x.id === state.project);
  if (!confirm(`Remove project "${p ? p.name : state.project}" from the editor?\n(Files on disk are not touched.)`)) return;
  try {
    await api(`/api/project/${state.project}`, {method: 'DELETE'});
    state.project = null;
    state.doc = null;
    await refreshProjects();
    toast('Project removed');
  } catch (e) { toast('Remove failed: ' + e.message, true); }
}

/* ------------------------------------------------------------------ */
/* LaTeX compilation                                                   */
/* ------------------------------------------------------------------ */

async function compileProject() {
  if (!state.project) return;
  const btn = $('#projcompile');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await ppost('/compile', {});
    window.open(res.pdf + '?t=' + Date.now(), '_blank');
    if (res.clean === false && res.log) {
      showCompileLog('The PDF was produced, but LaTeX reported problems:\n\n' + res.log);
    } else {
      toast('PDF compiled');
    }
  } catch (e) {
    showCompileLog(e.message);
  } finally {
    btn.disabled = !state.project;
    btn.textContent = 'PDF';
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

window.addEventListener('load', async () => {
  $('#projsel').addEventListener('change', e => switchProject(e.target.value));
  $('#projadd').addEventListener('click', addProject);
  $('#projcompile').addEventListener('click', compileProject);
  $('#projdel').addEventListener('click', removeProject);
  // MathLive virtual keyboard: reserve space for it and keep the equation
  // in view — driven by every geometry signal MathLive offers, plus a short
  // poll after editor open, so animation/late-layout can't miss it
  if (window.mathVirtualKeyboard) {
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
  // collapsible sidebar groups (remembered across sessions)
  const setupToggle = (headId, listId, key) => {
    const head = document.getElementById(headId);
    const list = document.getElementById(listId);
    const apply = c => {
      list.classList.toggle('sb-collapsed', c);
      head.classList.toggle('collapsed', c);
    };
    apply(localStorage.getItem(key) === '1');
    head.addEventListener('click', () => {
      const c = !list.classList.contains('sb-collapsed');
      localStorage.setItem(key, c ? '1' : '0');
      apply(c);
    });
  };
  setupToggle('filesHead', 'filelist', 'sb-files-collapsed');
  setupToggle('outlineHead', 'outline', 'sb-outline-collapsed');
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
  connectWS();
});
