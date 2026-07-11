#!/usr/bin/env node
// Prove that the shim delivers rule hot-reload, and that the bare server does not.
//
// The load-bearing discipline here is that the RED baseline runs FIRST, against the UNPROXIED
// server. Without it this script proves nothing: a test that only shows "the shim reloads" cannot
// tell a working shim from a server that was reloading all along. We assert the bug exists, then
// assert the shim fixes it.
//
// The money assertion is an UNPROMPTED `publishDiagnostics` — one that arrives carrying a rule's NEW
// message after that rule changed on disk, with the client having sent no `didChange` and no request
// of any kind. That single message is the whole feature: the server reloaded, and refreshed the open
// document, with zero client involvement.
//
//   node verify-lsp-reload.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createFrameReader, encodeFrame } from './bin/lsp-framing.mjs';

const SHIM = fileURLToPath(new URL('./bin/lsp-shim.mjs', import.meta.url));

const MSG_ONE = 'ORIGINAL_RULE_MESSAGE';
const MSG_TWO = 'RELOADED_RULE_MESSAGE';

let failed = false;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true; };

// --- a throwaway project. realpathSync is not decoration: on macOS os.tmpdir() is /var/folders/...
// which is a symlink into /private/var. If the rootUri we send disagrees with the path ast-grep
// canonicalises internally, it publishes NOTHING and the whole run looks like a shim failure.
// (An agent once burned fifty tool calls concluding "ast-grep refuses /tmp". It does not.)
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'vp-astgrep-reload-')));
const RULE = path.join(ROOT, 'rules', 'reload-probe.yml');
const DOC = path.join(ROOT, 'probe.js');

const writeRule = (message, pattern = 'forbidden($$$ARGS)') => {
  writeFileSync(RULE, `id: reload-probe\nlanguage: javascript\nseverity: warning\nmessage: ${message}\nrule:\n  pattern: ${pattern}\n`);
};

mkdirSync(path.join(ROOT, 'rules'), { recursive: true });
writeFileSync(path.join(ROOT, 'sgconfig.yml'), 'ruleDirs:\n  - rules\n');
writeRule(MSG_ONE);

const BAD_SOURCE = 'forbidden(1);\n';
const DOC_URI = pathToFileURL(DOC).href;

/**
 * Drive a language server over stdio. Uses the shim's OWN framing module, so the verifier dogfoods
 * the code it is verifying rather than re-rolling a second, subtly different reader.
 */
function driver (cmd, argv, env = {}) {
  const proc = spawn(cmd, argv, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });

  const pending = new Map();
  /** Every publishDiagnostics we have seen but not yet consumed. */
  const inbox = [];
  /** Resolvers waiting for the next one. */
  const waiters = [];

  const push = createFrameReader({
    onFrame: (_raw, msg) => {
      if (msg?.method === 'textDocument/publishDiagnostics') {
        const waiter = waiters.shift();
        if (waiter) waiter(msg.params); else inbox.push(msg.params);
      } else if (msg?.id !== undefined && 'result' in (msg ?? {}) && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
      }
    },
    onFramingError: (err) => { throw err; },
  });
  proc.stdout.on('data', push);

  const send = (msg) => proc.stdin.write(encodeFrame({ jsonrpc: '2.0', ...msg }));

  return {
    proc,
    stderr: () => stderr,
    send,
    request: (id, method, params) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${method}. stderr:\n${stderr}`)), 15_000);
      pending.set(id, (r) => { clearTimeout(t); resolve(r); });
      send({ id, method, params });
    }),
    /** Resolves with the next publishDiagnostics, or `null` if none arrives within `ms`. */
    nextDiagnostics: (ms) => new Promise((resolve) => {
      if (inbox.length) return resolve(inbox.shift());
      const t = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i !== -1) waiters.splice(i, 1);
        resolve(null);
      }, ms);
      const w = (params) => { clearTimeout(t); resolve(params); };
      waiters.push(w);
    }),
    /** Bring the server up and open the violating document. Returns its first diagnostics. */
    async open () {
      const rootUri = pathToFileURL(ROOT).href;
      // Await the initialize RESPONSE before anything else. tower-lsp (which ast-grep uses) silently
      // DISCARDS notifications that arrive before it reaches Initialized — ast-grep#2638. Send didOpen
      // early and you get no diagnostics, and conclude the server is broken when the harness is.
      await this.request(1, 'initialize', {
        processId: process.pid,
        rootUri,
        // Advertise NOTHING, on purpose. This models the pessimistic client, and it is the single
        // assumption this whole shim rests on.
        //
        // A spec-compliant server sends a *dynamic* registration only to a client that advertised
        // `workspace.didChangeWatchedFiles.dynamicRegistration`. Claude Code answers -32601 to the
        // registration and there is no public dump of what it advertises — so if ast-grep gated on
        // that capability, the shim would receive no registration in production, watch nothing, and
        // do nothing, while a verifier that helpfully advertised `true` stayed green forever. The
        // test would be measuring its own generosity.
        //
        // Measured (ast-grep 0.39.x): it registers UNCONDITIONALLY, capability or no capability. So
        // advertising nothing is the strictly stronger test, and it is the one we run — if a future
        // ast-grep starts gating, this goes red here instead of silently in everyone's editor.
        capabilities: {},
        workspaceFolders: [{ uri: rootUri, name: 'probe' }],
      });
      this.send({ method: 'initialized', params: {} });
      this.send({ method: 'textDocument/didOpen', params: { textDocument: { uri: DOC_URI, languageId: 'javascript', version: 1, text: BAD_SOURCE } } });
      return this.nextDiagnostics(15_000);
    },
  };
}

const messagesOf = (d) => (d?.diagnostics ?? []).map((x) => x.message);

try {
  // ------------------------------------------------------------------ RED: the bug, unproxied.
  console.log('RED — the bare server, with no shim (this is the bug):\n');
  {
    const bare = driver('ast-grep', ['lsp', '-c', path.join(ROOT, 'sgconfig.yml')]);
    const first = await bare.open();
    check(messagesOf(first).includes(MSG_ONE), `bare server diagnoses the violation ("${MSG_ONE}")`);

    writeRule(MSG_TWO);                       // change the rule on disk...
    const after = await bare.nextDiagnostics(3000); // ...and send NOTHING.

    check(after === null, 'bare server sends nothing at all after a rule change — it never learns');
    bare.proc.kill();
  }

  // ------------------------------------------------------------------ GREEN: the same, through the shim.
  console.log('\nGREEN — the same server, behind the shim:\n');
  writeRule(MSG_ONE); // reset

  // LSP_SHIM_DEBUG=1 so the assertions below can read what the shim decided. It is silent by default —
  // the "quiet by default" half of that contract is asserted separately, at the end.
  const shim = driver(process.execPath, [SHIM, 'ast-grep', 'lsp', '-c', path.join(ROOT, 'sgconfig.yml')], { LSP_SHIM_DEBUG: '1' });
  const first = await shim.open();
  check(messagesOf(first).includes(MSG_ONE), `shim is transparent: the violation still diagnoses ("${MSG_ONE}")`);

  // The shim must AMEND the capabilities it forwards. We advertised nothing (see `open()`), so with a
  // spec-compliant server that would mean no registration, no watcher, no reload — silently. ast-grep
  // happens to register unconditionally today, which papers over it; this asserts we are not relying
  // on that. It is the one message the shim rewrites rather than forwards verbatim.
  check(/injected workspace\.didChangeWatchedFiles\.dynamicRegistration=true/.test(shim.stderr()),
    'the shim advertises the watch capability it actually implements (so a compliant server still registers)');
  check(/watching .* for "\*\*\/\*\.\{yml,yaml\}"/.test(shim.stderr()),
    'and it watches the globs the SERVER registered, rather than any it hardcoded');

  // THE MONEY ASSERTION. Rewrite the rule on disk. Send no didChange, no request, nothing.
  writeRule(MSG_TWO);
  const reloaded = await shim.nextDiagnostics(8000);
  check(reloaded !== null, 'an UNPROMPTED publishDiagnostics arrives after the rule changed on disk');
  check(reloaded?.uri === DOC_URI, 'it refreshes the already-open document');
  check(messagesOf(reloaded).includes(MSG_TWO), `and it carries the NEW rule message ("${MSG_TWO}") — the server reloaded`);

  // The other half of the oracle: a rule that stops matching must CLEAR, unprompted. Without this a
  // shim that made the server fire on everything would pass.
  writeRule(MSG_TWO, 'neverMatchesAnything($$$ARGS)');
  const cleared = await shim.nextDiagnostics(8000);
  check(cleared !== null && cleared.diagnostics.length === 0, 'a rule that stops matching clears the diagnostics, still unprompted');

  // Regression guard: the shim must not have perturbed ordinary document sync on the way through.
  writeRule(MSG_TWO); // make it match again
  await shim.nextDiagnostics(8000);
  shim.send({ method: 'textDocument/didChange', params: { textDocument: { uri: DOC_URI, version: 2 }, contentChanges: [{ text: 'const ok = 1;\n' }] } });
  const edited = await shim.nextDiagnostics(8000);
  check(edited !== null && edited.diagnostics.length === 0, 'ordinary didChange still works through the shim (normal sync is intact)');

  // The shim must not leave an orphaned server behind when it dies.
  const childPid = shim.proc.pid;
  shim.proc.kill();
  await new Promise((r) => setTimeout(r, 1500));
  const alive = (() => { try { process.kill(childPid, 0); return true; } catch { return false; } })();
  check(!alive, 'killing the shim does not leave an orphaned language server behind');

  // ------------------------------------------------------------------ failure modes.
  console.log('\nFailure modes — the shim is quiet about success, never about failure:\n');
  {
    // Quiet by DEFAULT: a whole healthy session — startup, watch, AND a reload — with no env set at all.
    // A proxy in the hot path of every message should not narrate itself to a user who did not ask.
    writeRule(MSG_ONE);
    const quiet = driver(process.execPath, [SHIM, 'ast-grep', 'lsp', '-c', path.join(ROOT, 'sgconfig.yml')]);
    await quiet.open();
    writeRule(MSG_TWO);                       // trigger a real reload...
    await quiet.nextDiagnostics(8000);        // ...and confirm it actually happened
    quiet.proc.kill();
    check(!/\[lsp-shim\]/.test(quiet.stderr()), 'a healthy session — including a reload — prints NOTHING by default');

    // ...but a BROKEN shim must still shout. This is the guard that stops someone — most likely me —
    // quietly demoting a fault to debug() later. The whole reason this plugin exists is that ast-grep
    // reported its failure correctly and the CLIENT threw the message away; shipping a tool that fails
    // silently, right after discovering that, would be indefensible.
    const missing = spawn(process.execPath, [SHIM, 'definitely-not-a-real-binary', 'lsp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    missing.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((r) => missing.on('exit', r));
    check(code !== 0, `a missing server binary exits non-zero (got ${code})`);
    check(/not on PATH|ENOENT/.test(err), 'and says so in words WITHOUT LSP_SHIM_DEBUG — a fault is never quiet');
  }
} catch (err) {
  check(false, err.message);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n${failed ? 'RELOAD VERIFY FAILED' : 'RELOAD VERIFY OK — rules hot-reload through the shim, and demonstrably do not without it.'}`);
process.exit(failed ? 1 : 0);
