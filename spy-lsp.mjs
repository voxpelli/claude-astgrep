#!/usr/bin/env node
// A PASSTHROUGH LSP SPY. It answers nothing, swallows nothing, and changes nothing — it forwards every
// byte in both directions verbatim and *reports* the conversation to stderr.
//
//     <any LSP client>  <--stdio-->  spy-lsp  <--stdio-->  <any language server>
//
// WHY THIS EXISTS, AND WHY IT IS NOT THE SHIM
//
// `bin/lsp-shim.mjs` is a *participant*: it intercepts, answers, and injects. That makes it useless for
// finding out what the client would have done on its own — the moment you interpose a shim that answers
// a request, you can no longer see the client's answer. This spy is the opposite: it is deliberately
// inert, so what you observe is what the client and server actually do to each other.
//
// The distinction matters more than it sounds. Everything this plugin got WRONG, it got wrong by
// believing a claim about the wire instead of reading the wire:
//
//   * "Claude Code replies -32601 to client/registerCapability" — asserted for days on the strength of a
//     BYTE-LOG IN SOMEONE ELSE'S GITHUB ISSUE. It happens to be true. It could just as easily have been
//     `{result: null}` — an accept-then-ignore — which would have made the client a promise-breaker
//     rather than an honest decliner and inverted the entire upstream write-up. Nine lines of spy
//     settled it in one run.
//   * "servers hang on the unanswered request" — folklore, traceable to two reports that inferred
//     silence from symptoms WITHOUT a byte trace, then propagated through a downstream README.
//
// A spy is cheap. Hearsay about a protocol is not.
//
// WHAT IT REPORTS
//
//   * the client's `initialize` capabilities, verbatim (for many clients, published nowhere)
//   * every server->client REQUEST, and the client's literal answer — result, error, or silence
//   * every server->client NOTIFICATION (window/logMessage, window/showMessage, telemetry/event…)
//
// A NOTE ON WHAT IT CANNOT TELL YOU. A notification carries no id and expects no reply, so a client that
// DISPLAYS one and a client that DISCARDS one are byte-identical here. The spy proves the server SENT it.
// Proving the client SURFACED it needs a second, client-specific look at wherever that client routes such
// messages (for Claude Code: `claude --debug-file`, where they turn out not to appear at all). That
// asymmetry is structural, not a limitation of this script.
//
// USAGE
//
//   Directly:   node spy-lsp.mjs ast-grep lsp -c ./sgconfig.yml   2> spy.log
//
//   Inside a Claude Code plugin (the interesting case — this is how you observe the REAL client):
//     "lspServers": { "<id>": {
//        "command": "node",
//        "args": ["<abs>/spy-lsp.mjs", "ast-grep", "lsp", "-c", "${CLAUDE_PROJECT_DIR}/sgconfig.yml"],
//        "extensionToLanguage": { ".js": "javascript" }
//     }}
//   then: claude --plugin-dir <that-plugin> --debug-file /tmp/spy.log
//   and grep /tmp/spy.log for [SPY]. Claude Code surfaces a server's stderr, which is what we ride.
//   Trap: plugin LSP servers start LAZILY, on the first EDIT to a claimed extension — a Read will not
//   start one. Your probe must edit a file, not merely open it.
//
//   Env: SPY_BODIES=1  also dump full message bodies, not just a one-line summary.

import { spawn } from 'node:child_process';
import process from 'node:process';

import { createFrameReader } from './bin/lsp-framing.mjs';

const [command, ...args] = process.argv.slice(2);
const BODIES = process.env['SPY_BODIES'] === '1';

if (!command) {
  process.stderr.write('spy-lsp: usage: node spy-lsp.mjs <server-command> [args...]\n');
  process.exit(64);
}

const log = (msg) => process.stderr.write(`[SPY] ${msg}\n`);
const rule = () => log('─'.repeat(72));

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
child.on('error', (err) => { log(`could not start "${command}": ${err.message}`); process.exit(127); });
child.stderr.pipe(process.stderr);

/** server->client requests we are waiting to see the client answer. id -> {method, sentAt}. */
const outstanding = new Map();

const preview = (raw) => raw.toString('utf8').split('\r\n\r\n').slice(1).join('\r\n\r\n');

// --- server -> client. Note any request; forward EVERYTHING untouched.
const fromServer = createFrameReader({
  onFrame: (raw, msg) => {
    if (msg?.method && msg.id !== undefined) {
      outstanding.set(msg.id, { method: msg.method, sentAt: Date.now() });
      log(`server -> client  REQUEST  ${msg.method}  (id=${msg.id})`);
      if (BODIES) log(`  ${preview(raw)}`);
    } else if (msg?.method) {
      // A notification. No reply is coming, ever — that is the point, and the trap.
      const detail = msg.method.startsWith('window/')
        ? ` type=${msg.params?.type ?? '?'} ${JSON.stringify(msg.params?.message ?? '')}`
        : '';
      log(`server -> client  NOTIFY   ${msg.method}${detail}`);
      if (BODIES) log(`  ${preview(raw)}`);
    }
    process.stdout.write(raw);
  },
  onFramingError: (err) => log(`framing error (server->client): ${err.message}`),
});

// --- client -> server. Catch the answers to those requests, and the initialize capabilities.
const fromClient = createFrameReader({
  onFrame: (raw, msg) => {
    if (msg?.method === 'initialize') {
      rule();
      log('CLIENT CAPABILITIES (as sent in `initialize`) — for many clients, published nowhere:');
      log(`  ${JSON.stringify(msg.params?.capabilities ?? {})}`);
      rule();
    }

    if (msg?.id !== undefined && outstanding.has(msg.id)) {
      const { method, sentAt } = outstanding.get(msg.id);
      outstanding.delete(msg.id);
      const ms = Date.now() - sentAt;
      if (msg.error) {
        log(`client -> server  ERROR    ${method}  ->  ${msg.error.code} ${JSON.stringify(msg.error.message)}  (${ms}ms)  ** THE CLIENT DECLINED **`);
      } else {
        log(`client -> server  RESULT   ${method}  ->  ${JSON.stringify(msg.result)}  (${ms}ms)  ** THE CLIENT ACCEPTED **`);
      }
      if (BODIES) log(`  ${preview(raw)}`);
    }
    child.stdin.write(raw);
  },
  onFramingError: (err) => log(`framing error (client->server): ${err.message}`),
});

child.stdout.on('data', fromServer);
process.stdin.on('data', fromClient);

child.on('exit', (code, signal) => {
  // A request the client NEVER answered is the loudest finding this tool can produce — a server blocked
  // on it would hang forever. Say so explicitly; silence here must never be mistaken for "fine".
  for (const [id, { method }] of outstanding) {
    log(`** NEVER ANSWERED **  ${method} (id=${id}) — the client received this request and said nothing.`);
  }
  process.stdin.pause();
  process.exitCode = signal ? 1 : (code ?? 0);
});
