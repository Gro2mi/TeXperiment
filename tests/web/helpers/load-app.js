// Loads the real web/app.js into a fresh jsdom window built from the real
// web/index.html shell, with the minimum stubs app.js needs at boot:
// fetch, WebSocket, katex and a math-field custom element (MathLive).
// Top-level function declarations in app.js become window globals, which
// is how the M4 suites reach them (see TESTING.md).
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
export const webDir = join(here, '..', '..', '..', 'web');

/**
 * @param {{projects?: Array<Object>, responses?: Object<string,*>}} opts
 *   projects: what GET /api/projects returns (default []).
 *   responses: map of URL substring → JSON value; matched longest-first
 *   before the default empty-object response.
 * @returns {Window} the jsdom window with app.js evaluated on it
 */
export function loadApp({projects = [], responses = {}} = {}) {
  const html = readFileSync(join(webDir, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8080/',
    pretendToBeVisual: true,
    // execute injected <script> content with real classic-script
    // semantics: top-level function declarations land on window and
    // const/let become global lexical bindings — eval() would keep the
    // whole strict-mode file in a private scope instead. External CDN
    // scripts (index.html tags) are not fetched by jsdom.
    runScripts: 'dangerously',
  });
  const {window} = dom;

  const routes = Object.entries(responses).sort((a, b) => b[0].length - a[0].length);
  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/projects')) {
      return jsonResponse(window, projects);
    }
    for (const [frag, value] of routes) {
      if (u.includes(frag)) return jsonResponse(window, value);
    }
    return jsonResponse(window, {});
  };

  // never opens, never closes — connectWS's handlers simply stay dormant
  class FakeWebSocket {
    constructor() {}
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  }
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  window.WebSocket = FakeWebSocket;

  // KaTeX stub so watchMathLibs() exits immediately and math rendering is
  // deterministic in tests (renderToString wraps the tex in a marker span)
  window.katex = {
    renderToString: (tex) => `<span class="katex-stub">${tex}</span>`,
  };
  // MathLive stub: registering the custom element makes watchMathLibs()
  // consider it wired; the mathVirtualKeyboard API is absent, which
  // wireMathKeyboard() already guards against.
  window.customElements.define(
    'math-field', class extends window.HTMLElement {});

  // run app.js as a real classic script: function declarations become
  // window properties (window.renderInline, ...), while `const state`
  // becomes a global lexical binding — reach it from tests via
  // window.eval('state')
  const script = window.document.createElement('script');
  script.textContent = readFileSync(join(webDir, 'app.js'), 'utf8');
  window.document.body.appendChild(script);
  return window;
}

function jsonResponse(window, value) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}
