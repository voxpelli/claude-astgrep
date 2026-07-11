#!/usr/bin/env node
// A stdio shim that sits between an LSP client and an LSP server, and answers the one request the
// client refuses to.
//
//     Claude Code  <--stdio-->  THIS  <--stdio-->  <any language server>
//
// WHY THIS EXISTS
//
// The LSP spec lets a server ask the *client* to watch files on its behalf, via a
// `client/registerCapability` request for `workspace/didChangeWatchedFiles`. Claude Code replies
// `-32601 "Unhandled method"` and watches nothing, so ast-grep never learns its rules changed and
// serves its STARTUP RULE SET FOREVER, while document sync keeps working perfectly.
//
// Claude Code is within its rights here, which is worth stating plainly. LSP makes dynamic
// registration opt-in — "a client opts in via the `dynamicRegistration` property" — and Claude Code
// advertises that property as `undefined` (measured). It never promised to watch files. ast-grep asks
// anyway without checking, which is impolite but not a clear spec violation: `didChangeWatchedFiles`
// has no static path at all, so asking and being refused is a legitimate outcome. `rust-analyzer` and
// `pyright` DO check, see the refusal coming, and self-watch instead — which is why they work here and
// ast-grep does not. That fallback is the real fix; this shim is the bridge to it.
//
// AND THE FAILURE WAS NEVER SILENT — that part cost a day to learn. ast-grep detects the refusal and
// reports it accurately, over `window/logMessage`:
//
//     [ERROR] Failed to register file watchers: Error { code: MethodNotFound, ... }
//
// CLAUDE CODE DISCARDS THAT MESSAGE. It surfaces a server's stderr under --debug but drops
// window/logMessage entirely, so a precise, immediate error report became "the rules just don't
// reload". That is the reason this file's own logging is loud about faults and quiet about success:
// building a tool that fails silently, right after that, would be a poor joke.
//
// anthropics/claude-code#32595 and its re-file #52693 are both CLOSED / NOT_PLANNED. A client-side
// fix is not coming, which is what promotes this from a workaround to the only path — until ast-grep
// self-watches, at which point this file should be deleted.
//
// WHAT IT DOES, AND WHICH HALF MATTERS
//
//   * Watching + injecting is the ENGINE. It is what actually delivers reload.
//   * Answering `client/registerCapability` is what makes it CORRECT and GENERAL. On its own it
//     achieves nothing — the reply only says "registration accepted". We do it because (a) the
//     registration payload is the source of truth for *what to watch*, so the watcher cannot rot when
//     a server changes its patterns, (b) it stops the client's `-32601` reaching the server, and
//     (c) it is what would unbreak csharp-lsp and elixir-lsp.
//
// SERVER-AGNOSTIC BY CONSTRUCTION. It spawns argv[0]; it watches whatever globs the server itself
// registers. Nothing here knows what ast-grep is. That is deliberate — this wants to be extracted.
//
// Usage:  node lsp-shim.mjs <server-command> [args...]
// Env:    LSP_SHIM_DISABLE=1  exec the server directly, shim entirely out of the loop (kill switch)
//         LSP_SHIM_DEBUG=1    dump the client's advertised capabilities and every injection

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createGlobWatcher } from './glob-watch.mjs';
import { createFrameReader, encodeFrame } from './lsp-framing.mjs';

const [command, ...args] = process.argv.slice(2);
const DEBUG = process.env['LSP_SHIM_DEBUG'] === '1';

if (!command) {
  process.stderr.write('lsp-shim: usage: node lsp-shim.mjs <server-command> [args...]\n');
  process.exit(64); // EX_USAGE
}

// Everything we say goes to stderr — stdout is the LSP channel and must carry nothing else.
//
// Two levels, and the split is deliberate. This whole shim exists because a failure was invisible:
// ast-grep reported its failed registration accurately, over `window/logMessage`, and Claude Code
// discarded the message — so a precise, immediate error report became "the rules just don't reload"
// and cost a day to rediagnose. Reproducing that in our own code would be a poor joke.
//
//   log()   — the shim is degraded or dead. ALWAYS printed. No server, no `node`, watcher failed to
//             attach, framing collapsed to a raw pipe. Every one of these means the user is about to
//             get stale rules or none, and must never have to guess why.
//   debug() — steady-state chatter. Off unless LSP_SHIM_DEBUG=1. The capability probe, the startup
//             confirmation, and a line per reload — useful once, noise forever.
//
// Note that stderr is the ONLY channel that reaches anyone here: Claude Code surfaces a server's
// stderr under `--debug`, but drops `window/logMessage` entirely. So this is not a nice-to-have.
const log = (msg) => process.stderr.write(`[lsp-shim] ${msg}\n`);
const debug = (msg) => { if (DEBUG) log(msg); };

// --- Kill switch. Not a debug flag: if this shim ever breaks a server, the user needs a way to get
// their diagnostics back that does not involve waiting for us to ship a fix.
if (process.env['LSP_SHIM_DISABLE'] === '1') {
  log('disabled via LSP_SHIM_DISABLE — running the server directly, unproxied');
  const direct = spawn(command, args, { stdio: 'inherit' });
  direct.on('error', (err) => { log(`failed to start ${command}: ${err.message}`); process.exit(127); });
  direct.on('exit', (code, signal) => { process.exit(signal ? 1 : (code ?? 0)); });
} else {
  main();
}

function main () {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  child.on('error', (err) => {
    // ENOENT here is the single likeliest user-facing failure: the server binary is not on PATH.
    // Say so in words rather than letting the client report a mute, dead server.
    log(`failed to start "${command}": ${err.message}`);
    if (err.code === 'ENOENT') log(`"${command}" is not on PATH. Install it, or set LSP_SHIM_DISABLE=1 to bypass this shim.`);
    process.exit(127);
  });

  // The server's own stderr is how `claude --debug` surfaces its failures. Never buffer it, never
  // swallow it, never interleave it with ours beyond the prefix above.
  child.stderr.pipe(process.stderr);

  /** Registration id -> the globs that registration asked us to watch. */
  const registrations = new Map();
  /** Absolute, realpath'd workspace root, learned from the client's `initialize`. */
  let root = null;
  let disposeWatcher = null;

  // A watcher event can land in the window between the server dying and our cleanup running, and
  // writing to a dead pipe throws EPIPE. Nothing useful can come of that: if the server is gone there
  // is nobody to tell about a rule change.
  child.stdin.on('error', (err) => debug(`server stdin: ${err.message}`));
  const toChild = (message) => {
    if (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) return;
    child.stdin.write(encodeFrame(message));
  };

  /**
   * Tell the server its watched files changed. This is the payload Claude Code should have been
   * sending all along, and the entire reason the shim exists.
   */
  const injectDidChangeWatchedFiles = (paths) => {
    const changes = paths.map((p) => ({
      uri: pathToFileURL(p).href,
      // 1 = Created, 2 = Changed, 3 = Deleted. We cannot always distinguish create from change from
      // an fs event alone, and no server we care about treats them differently — but a DELETED file
      // that we report as Changed would make the server try to read it, so that one we do get right.
      type: existsSync(p) ? 2 : 3,
    }));
    toChild({ jsonrpc: '2.0', method: 'workspace/didChangeWatchedFiles', params: { changes } });
    debug(`reload: ${changes.length} watched file(s) changed — ${paths.join(', ')}`);
  };

  const restartWatcher = () => {
    disposeWatcher?.();
    disposeWatcher = null;

    const globs = [...new Set([...registrations.values()].flat())];
    if (!root || globs.length === 0) return;

    disposeWatcher = createGlobWatcher({
      root,
      globs,
      log,
      onChange: injectDidChangeWatchedFiles,
    });
    debug(`watching ${root} for ${globs.map((g) => JSON.stringify(g)).join(', ')}`);
  };

  // --- client -> server. Forwarded verbatim, with EXACTLY ONE exception: `initialize`.
  pump(process.stdin, child.stdin, 'client->server', (message) => {
    if (message?.method !== 'initialize') return;

    const params = message.params ?? {};
    const uri = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    const dir = uri ? fileURLToPath(uri) : (params.rootPath ?? process.cwd());
    // realpath matters more than it looks: on macOS /tmp is a symlink to /private/tmp, and a root
    // that disagrees with the server's canonicalised view of the same directory silently produces
    // zero diagnostics. (This cost an afternoon.)
    try { root = realpathSync(dir); } catch { root = dir; }

    // A free probe: nobody has published what Claude Code actually advertises here. If it OMITS
    // dynamicRegistration, then servers that respect the capability (rust-analyzer, pyright) correctly
    // decline to register and fall back to self-watching. If it ADVERTISES it and then answers -32601
    // to the registration, that is a plain broken promise.
    const advertised = params.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration;
    debug(`client advertises workspace.didChangeWatchedFiles.dynamicRegistration = ${advertised}`);
    debug(`client capabilities: ${JSON.stringify(params.capabilities)}`);

    // THE ONE REWRITE. Everything else on this stream is passed through byte-for-byte; here we amend
    // the client's advertised capabilities before the server sees them.
    //
    // This is not a hack — it is the shim telling the truth. The spec says a server may only use
    // *dynamic* registration for watched files if the client advertised support for it. With this shim
    // in the path, the client genuinely DOES support it: we answer the registration, we do the
    // watching, we send the notification. Declaring the capability is simply an accurate statement
    // about the client-side the server is actually talking to — which is us.
    //
    // And it removes a fragility that would otherwise be invisible. ast-grep today sends the
    // registration UNCONDITIONALLY, without checking this capability — which is itself a small spec
    // violation, and happens to be the only reason a shim works at all. If ast-grep ever fixes that,
    // a shim that had stayed silent here would suddenly receive no registration, watch nothing, and
    // die quietly. Advertising the capability we actually implement makes us correct either way.
    if (!advertised) {
      const capabilities = structuredClone(params.capabilities ?? {});
      capabilities.workspace ??= {};
      capabilities.workspace.didChangeWatchedFiles = {
        ...capabilities.workspace.didChangeWatchedFiles,
        dynamicRegistration: true,
        // NOT relativePatternSupport: we resolve globs against the workspace root, not against an
        // arbitrary RelativePattern baseUri. Advertising it would be a claim we cannot honour.
      };
      debug('injected workspace.didChangeWatchedFiles.dynamicRegistration=true — the shim implements it, so the server should be told');
      return { ...message, params: { ...params, capabilities } };
    }
  });

  // --- server -> client. The interception lives here.
  pump(child.stdout, process.stdout, 'server->client', (message) => {
    const { method, id, params } = message ?? {};

    if (method === 'client/registerCapability' && id !== undefined) {
      for (const reg of params?.registrations ?? []) {
        if (reg.method !== 'workspace/didChangeWatchedFiles') continue;
        const globs = (reg.registerOptions?.watchers ?? [])
          // globPattern is either a plain string or a RelativePattern {baseUri, pattern}.
          .map((w) => (typeof w.globPattern === 'string' ? w.globPattern : w.globPattern?.pattern))
          .filter(Boolean);
        if (globs.length) registrations.set(reg.id, globs);
      }
      // The reply the client owes and will not send. Without it a tower-lsp server merely goes stale;
      // a blocking server hangs here forever.
      toChild({ jsonrpc: '2.0', id, result: null });
      restartWatcher();
      return false; // Swallow: the client cannot handle it and would only answer -32601.
    }

    if (method === 'client/unregisterCapability' && id !== undefined) {
      for (const reg of params?.unregisterations ?? []) registrations.delete(reg.id);
      toChild({ jsonrpc: '2.0', id, result: null });
      restartWatcher();
      return false;
    }

    return true; // Everything else is the client's business, not ours.
  });

  // --- lifecycle. The client reads our exit code to decide whether the server is alive; if we
  // swallow the child's, a dead server looks healthy. (`ast-grep lsp` exits 6 with no sgconfig.yml.)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }

  child.on('exit', (code, signal) => {
    disposeWatcher?.();
    // Stop holding the loop open, but do NOT process.exit(): that would truncate anything still
    // buffered in our stdout. Setting exitCode and letting the loop drain flushes it first.
    process.stdin.pause();
    if (signal) debug(`server terminated by ${signal}`);
    process.exitCode = signal ? 1 : (code ?? 0);
  });

  // If WE are killed, the child's stdin hits EOF and any well-behaved language server exits. That is
  // the only mechanism that survives SIGKILL, where no handler of ours can run.
  process.on('exit', () => { if (!child.killed) child.kill(); });
}

/**
 * Forward a framed LSP stream, giving `inspect` a look at each message on the way past.
 *
 * Two-tier failure, because this sits in the hot path of every single message and must never be the
 * reason a server dies:
 *
 *   INSPECTION error (our logic threw on an unexpected shape) — stop inspecting, keep forwarding.
 *     We lose hot reload; the user keeps their language server.
 *   FRAMING error (byte boundaries are no longer trustworthy) — stop parsing entirely and become a
 *     dumb pipe for the rest of the process, starting with the bytes the reader had not consumed.
 *     Guessing at boundaries would silently reorder or drop messages, which is far worse than being
 *     useless.
 *
 * @param {NodeJS.ReadableStream} source
 * @param {NodeJS.WritableStream} dest
 * @param {string} label
 * @param {(message: unknown) => false | object | void} inspect  Return `false` to swallow the message,
 *   an object to forward THAT instead (re-serialised), or nothing to forward the original bytes.
 */
function pump (source, dest, label, inspect) {
  let rawPipe = false;
  let inspecting = true;

  const push = createFrameReader({
    onFrame: (raw, message) => {
      let verdict;
      if (inspecting && message !== undefined) {
        try {
          verdict = inspect(message);
        } catch (err) {
          inspecting = false;
          log(`${label}: inspection failed (${err.message}) — forwarding blind from here on; hot reload is off, the server is not`);
        }
      }

      if (verdict === false) return;                              // Swallowed.
      // Default is the ORIGINAL bytes — never a re-serialisation, which would quietly rewrite key
      // order and unicode escaping on every message. A rewrite happens only when `inspect` explicitly
      // hands back a replacement, which today is exactly one message (`initialize`).
      dest.write(typeof verdict === 'object' && verdict !== null ? encodeFrame(verdict) : raw);
    },
    onFramingError: (err, pending) => {
      rawPipe = true;
      log(`${label}: ${err.message} — degrading to a raw pipe`);
      if (pending.length) dest.write(pending);
    },
  });

  source.on('data', (chunk) => { if (rawPipe) dest.write(chunk); else push(chunk); });
  source.on('end', () => { if (dest !== process.stdout) dest.end(); });
}
