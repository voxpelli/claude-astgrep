#!/usr/bin/env node
// Verify the ast-grep language server actually works — by driving the REAL server over stdio and
// watching what it publishes. Not "does the binary exist"; "does it diagnose".
//
// The test has two halves, and the second one is the important one:
//
//   RED   — open a buffer that violates a real rule => a diagnostic MUST arrive, carrying that
//           rule's id as its `code`.
//   GREEN — change the buffer to the fixed form     => the diagnostics list MUST go EMPTY.
//
// A check that only ever asserts RED cannot tell a working linter from one that fires on
// everything. The GREEN half is what makes this an oracle rather than a smoke test.
//
// Usage:  node verify-lsp.mjs [path/to/project]      (default: cwd)
// The project must have an sgconfig.yml and at least one rule; the fixture is generated to match
// whichever rule we can satisfy (see FIXTURES).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] ?? process.cwd());
const SGCONFIG = path.join(ROOT, 'sgconfig.yml');

if (!existsSync(SGCONFIG)) {
  console.error(`FAIL: no sgconfig.yml at ${SGCONFIG}`);
  console.error('The ast-grep LSP hard-exits without one ("No ast-grep project configuration is found").');
  console.error('That is exactly why the plugin passes -c explicitly — but this verifier needs a real project.');
  process.exit(1);
}

// --- fixtures: (violating source, fixed source) pairs, keyed by the rule id they should trip.
// Each is a self-contained JS snippet. We use the FIRST one whose rule exists in this project, so
// the verifier works in any repo carrying one of these rules, and says so loudly if none match.
// `dir` matters: a rule may carry a `files:` glob (e.g. `src/**/*.js`), and a buffer outside that
// glob is simply not in scope — the server correctly says nothing, and a verifier that placed its
// document at the repo root would read that silence as "the LSP is broken". It is not; the document
// was just somewhere the rule does not apply. (This is how the first run of this script failed.)
const FIXTURES = [
  {
    rule: 'no-inline-lexicographic-cmp',
    dir: 'src',
    bad: 'const s = xs.sort((a, b) => (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));\n',
    good: 'const s = xs.sort((a, b) => cmp(a.id, b.id));\n',
  },
  {
    rule: 'no-commonjs-require',
    dir: '.',
    bad: "const x = require('node:fs');\n",
    good: "import x from 'node:fs';\n",
  },
];

const ruleIds = new Set();
const rulesDir = (() => {
  const cfg = readFileSync(SGCONFIG, 'utf8');
  const m = cfg.match(/ruleDirs:\s*\n\s*-\s*(.+)/);
  return m ? path.join(ROOT, m[1].trim()) : null;
})();
if (rulesDir && existsSync(rulesDir)) {
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(rulesDir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const m = readFileSync(path.join(rulesDir, f), 'utf8').match(/^id:\s*(\S+)/m);
    if (m) ruleIds.add(m[1]);
  }
}

const fixture = FIXTURES.find((f) => ruleIds.has(f.rule));
if (!fixture) {
  console.error(`FAIL: none of this verifier's fixture rules exist in ${rulesDir ?? '(no ruleDirs)'}`);
  console.error(`  looked for: ${FIXTURES.map((f) => f.rule).join(', ')}`);
  console.error(`  found:      ${[...ruleIds].join(', ') || '(none)'}`);
  process.exit(1);
}
console.log(`project : ${ROOT}`);
console.log(`rule    : ${fixture.rule}  (of ${ruleIds.size} rule(s) in this project)\n`);

// --- minimal LSP client over stdio. Content-Length framing; no dependencies.
const server = spawn('ast-grep', ['lsp', '-c', SGCONFIG], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
server.stderr.on('data', (d) => { stderr += d; });

const send = (msg) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

/** Resolvers waiting for the next publishDiagnostics notification. */
const waiters = [];
/** Resolvers waiting for a response to a request id. */
const pending = new Map();
let buf = Buffer.alloc(0);

server.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const header = buf.subarray(0, headerEnd).toString();
    const len = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
    if (!Number.isInteger(len) || buf.length < headerEnd + 4 + len) return;
    const msg = JSON.parse(buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString());
    buf = buf.subarray(headerEnd + 4 + len);

    if (msg.method === 'textDocument/publishDiagnostics') {
      waiters.shift()?.(msg.params);
    } else if (msg.id !== undefined && msg.result !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  }
});

const request = (id, method, params) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for the ${method} response. stderr:\n${stderr}`)), 15_000);
  pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
  send({ id, method, params });
});

const nextDiagnostics = (label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error(`timed out waiting for publishDiagnostics (${label}). stderr:\n${stderr}`));
  }, 15_000);
  waiters.push((params) => { clearTimeout(timer); resolve(params); });
});

// The URI must be inside the project AND inside the rule's `files:` glob (see FIXTURES.dir). It does
// NOT need to exist on disk: LSP is buffer-based and didOpen supplies the text, so the verifier never
// writes a byte into the repo it is checking.
const uri = pathToFileURL(path.join(ROOT, fixture.dir, '__vp_astgrep_verify__.js')).href;

let failed = false;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };

try {
  // AWAIT the initialize RESPONSE before sending anything else. This is not politeness — the LSP
  // spec forbids the client from sending further messages until initialize returns, and ast-grep
  // SILENTLY DISCARDS a didOpen that arrives early. The first cut of this script fired them
  // immediately, saw no diagnostics, and would have "proved" the LSP doesn't work. It works fine;
  // the harness was wrong. A silent discard on protocol violation is precisely the failure mode
  // that makes a broken oracle look like a broken subject.
  const root = pathToFileURL(ROOT).href;
  const caps = await request(1, 'initialize', {
    processId: process.pid,
    rootUri: root,
    capabilities: {},
    workspaceFolders: [{ uri: root, name: path.basename(ROOT) }],
  });
  check(caps?.serverInfo?.name?.includes('ast-grep') ?? true, `server is up (${caps?.serverInfo?.name ?? 'unnamed'})`);
  send({ method: 'initialized', params: {} });

  // --- RED: the violating buffer must produce a diagnostic carrying the rule id.
  send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'javascript', version: 1, text: fixture.bad } } });
  const red = await nextDiagnostics('violating buffer');
  const codes = red.diagnostics.map((d) => d.code);
  check(red.diagnostics.length > 0, `violating buffer produces ${red.diagnostics.length} diagnostic(s)`);
  check(codes.includes(fixture.rule), `diagnostic code is the rule id ("${fixture.rule}"), got: ${JSON.stringify(codes)}`);
  if (red.diagnostics[0]) {
    const d = red.diagnostics[0];
    check(typeof d.message === 'string' && d.message.length > 0, `carries the rule's message (${d.message.slice(0, 48)}…)`);
    check(d.severity === 1 || d.severity === 2, `carries a severity (${d.severity === 1 ? 'error' : 'warning'})`);
  }

  // --- GREEN: the fixed buffer must clear them. Without this half, an always-firing linter passes.
  send({
    method: 'textDocument/didChange',
    params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: fixture.good }] },
  });
  const green = await nextDiagnostics('fixed buffer');
  check(green.diagnostics.length === 0, `fixed buffer clears the diagnostics (got ${green.diagnostics.length})`);
} catch (err) {
  check(false, err.message);
} finally {
  server.kill();
}

console.log(`\n${failed ? 'VERIFY FAILED' : 'VERIFY OK — the ast-grep LSP diagnoses, and stops diagnosing when the code is fixed.'}`);
process.exit(failed ? 1 : 0);
