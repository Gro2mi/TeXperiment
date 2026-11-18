// Spawns the real texperiment server (python -m texperiment) against a
// throwaway copy of demo/ — a git repo with an initial commit so the
// source-control panel has something to show. HOME/USERPROFILE are
// pointed at a temp dir so the spawned app never touches the real
// ~/.texperiment config or proof dictionaries.
import {spawn} from 'node:child_process';
import {execFileSync} from 'node:child_process';
import {cpSync, mkdtempSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)),
                      '..', '..', '..');
const demoDir = join(repoRoot, 'demo');

const JUNK = /\.(aux|log|pdf|fls|fdb_latemk|bak|out|toc|synctex\.gz)$/;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const {port} = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function git(dir, ...args) {
  return execFileSync('git',
    ['-c', 'user.email=e2e@test', '-c', 'user.name=E2E',
     '-c', 'core.autocrlf=false', ...args],
    {cwd: dir, stdio: 'pipe'}).toString();
}

async function waitReady(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(baseUrl + '/api/projects');
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not become ready within ' + timeoutMs + 'ms');
}

export async function startServer() {
  const workDir = mkdtempSync(join(tmpdir(), 'texperiment-e2e-'));
  const projDir = join(workDir, 'demo');
  cpSync(demoDir, projDir, {recursive: true,
    filter: (src) => !JUNK.test(src)});
  git(projDir, 'init', '-b', 'main');
  // repo-LOCAL identity: the spawned server runs with an isolated HOME
  // (no ~/.gitconfig), so the app's own commits would fail with
  // "Author identity unknown" without this
  git(projDir, 'config', 'user.email', 'e2e@test');
  git(projDir, 'config', 'user.name', 'E2E');
  git(projDir, 'add', '-A');
  git(projDir, 'commit', '-m', 'initial');

  const home = join(workDir, 'home');
  const port = await freePort();
  const env = {...process.env,
    USERPROFILE: home, HOME: home,
    PYTHONUNBUFFERED: '1'};
  const proc = spawn('python', ['-m', 'texperiment',
    join(projDir, 'main.tex'), '--port', String(port),
    '--proof-engine', 'spellcheck'],
    {cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe']});
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitReady(baseUrl, 30000);
  } catch (e) {
    proc.kill();
    throw new Error(`server startup failed:\n${log}`, {cause: e});
  }
  const projects = await (await fetch(baseUrl + '/api/projects')).json();
  const pid = projects[0].id;

  return {
    baseUrl,
    pid,
    projDir,
    log: () => log,
    async blockIdByPrefix(prefix, file) {
      const doc = await (await fetch(
        `${baseUrl}/api/project/${pid}/doc`)).json();
      const hits = doc.blocks.filter(b =>
        b.source.replace(/^\s+/, '').startsWith(prefix) &&
        (file === undefined || b.file === file));
      if (hits.length !== 1) {
        throw new Error(`expected 1 block for ${JSON.stringify(prefix)}, ` +
                        `got ${hits.length}`);
      }
      return hits[0].id;
    },
    readProjectFile(rel) {
      return readFileSync(join(projDir, rel), 'utf8');
    },
    fileExists(rel) {
      return existsSync(join(projDir, rel));
    },
    git(...args) {
      return git(projDir, ...args);
    },
    async stop() {
      proc.kill();
      await new Promise(r => {
        proc.on('exit', r);
        setTimeout(r, 3000);
      });
    },
  };
}
