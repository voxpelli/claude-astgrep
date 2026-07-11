// Watch a workspace for changes to files matching a set of LSP glob patterns.
//
// This is the ENGINE of the shim. Answering `client/registerCapability` is what makes the shim
// correct and general, but this is what actually delivers reload: a language server that asked the
// client to watch files on its behalf gets told, by us, when they change.
//
// Server-agnostic by construction: the globs are whatever the *server* registered. Nothing here
// knows what ast-grep is, or that `.yml` is interesting.
//
// Two decisions worth naming:
//
//   * We watch DIRECTORIES recursively, not individual files. Editors (and `ast-grep`'s own users)
//     commonly save via write-temp-then-rename, which replaces the inode. A watch bound to a file
//     follows the *old* inode into oblivion and goes silently deaf — the worst failure mode we have,
//     because it looks exactly like working. A recursive directory watch survives the rename.
//   * Changes are coalesced. A save can emit several events, and an editor may rewrite a file more
//     than once in a burst; each one would otherwise cost a full rule reload.

import { watch } from 'node:fs';
import path from 'node:path';

/** Never descend into these — they are large, noisy, and never contain a server's config. */
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', 'target', 'dist', '.venv', '__pycache__']);

/**
 * Translate one LSP glob pattern into a RegExp.
 *
 * Supports the subset LSP actually specifies: `*` (any run of chars within a path segment), `**`
 * (any number of segments), `?` (one char), `{a,b}` (alternation), `[abc]` / `[!abc]` (char class).
 *
 * @param {string} glob  e.g. `**\/*.{yml,yaml}`
 * @returns {RegExp} anchored, matching a `/`-separated path relative to the watch root
 */
export function globToRegExp (glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may match zero segments — so `**/*.yml` has to match a bare `a.yml` at the root too.
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:[^/]*/)*'; } else { re += '.*'; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      re += '(?:';
    } else if (c === '}') {
      re += ')';
    } else if (c === ',') {
      re += '|';
    } else if (c === '[') {
      const close = glob.indexOf(']', i);
      if (close === -1) { re += '\\['; continue; }
      const body = glob.slice(i + 1, close);
      re += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      i = close;
    } else {
      re += c.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Decide when a burst of filesystem events should be flushed to the server.
 *
 * Leading edge first, then a trailing debounce — NOT a pure debounce.
 *
 * A pure trailing debounce taxes every rule edit with latency in order to guard against bursts that
 * usually do not happen. Firing on the leading edge inverts that: the lone save — the overwhelmingly
 * common case — reloads immediately, at zero cost, and the debounce becomes insurance that is free
 * when it is not needed. It also means the debounce window can be generous without anyone paying for
 * it.
 *
 * The trailing flush is not redundant. It exists for two cases:
 *
 *   - A burst (Save All, `git checkout`, a formatter): the leading flush reloads with only the first
 *     file's changes; the trailing one reloads with all of them.
 *   - A truncate-then-write saver: the leading flush can catch a file mid-write, and `ast-grep`
 *     SILENTLY IGNORES an invalid rule (ast-grep/ast-grep#722, open) — so a torn read makes rules
 *     quietly vanish. The trailing flush re-reads the finished file and restores them. The failure is
 *     self-healing, a few hundred ms wide, rather than sticky.
 *
 * `maxWait` is the anti-stall ceiling: an unbroken stream of changes would otherwise reset the
 * debounce forever and the server would never hear about anything after the leading flush.
 *
 * @param {object} ctx
 * @param {() => void} ctx.flush            Injects `workspace/didChangeWatchedFiles`. No-ops if nothing is dirty.
 * @param {number} ctx.debounceMs           Quiet period to wait for after the last change of a burst.
 * @param {number} ctx.maxWaitMs            Hard ceiling: flush by now even if changes keep arriving.
 * @param {{ debounce: NodeJS.Timeout | null, max: NodeJS.Timeout | null }} ctx.timers  Mutable slot
 *   for the two timers; `flush` clears and nulls both.
 * @returns {void}
 */
export function scheduleFlush ({ flush, debounceMs, maxWaitMs, timers }) {
  // No timers pending => no burst in progress => as far as we know this is a lone write. Reload now.
  // (If more changes follow, the timers below turn this into the first flush of a burst instead.)
  if (!timers.debounce && !timers.max) {
    flush();
  } else {
    clearTimeout(timers.debounce);
  }

  // Trailing edge. After a leading flush there is nothing dirty left, so this fires as a cheap no-op
  // unless more changes actually arrived — which is exactly when we want it.
  timers.debounce = setTimeout(flush, debounceMs);
  timers.max ??= setTimeout(flush, maxWaitMs);
}

/**
 * @param {object} options
 * @param {string} options.root        Absolute, realpath'd workspace root.
 * @param {string[]} options.globs     LSP glob patterns, relative to `root`.
 * @param {(paths: string[]) => void} options.onChange  Called with the changed paths, coalesced.
 * @param {(msg: string) => void} [options.log]
 * @param {number} [options.debounceMs]
 * @param {number} [options.maxWaitMs]
 * @returns {() => void} dispose
 */
// The leading-edge flush means a lone save reloads instantly, so the debounce costs nobody anything
// and can afford to be generous — it only ever delays the *second* reload of a burst.
export function createGlobWatcher ({ root, globs, onChange, log = () => {}, debounceMs = 250, maxWaitMs = 1000 }) {
  const patterns = globs.map(globToRegExp);
  const dirty = new Set();
  const timers = { debounce: null, max: null };

  const flush = () => {
    clearTimeout(timers.debounce); timers.debounce = null;
    clearTimeout(timers.max); timers.max = null;
    if (dirty.size === 0) return;
    const paths = [...dirty];
    dirty.clear();
    onChange(paths);
  };

  let watcher;
  try {
    // `recursive` is supported on macOS and Windows natively, and on Linux since Node 20.
    watcher = watch(root, { recursive: true, persistent: false });
  } catch (err) {
    // NEVER quiet this. A watcher that fails to attach produces exactly the failure this whole shim
    // exists to fix: rules silently stop reloading, everything else keeps working, and the user is
    // left to guess. Say it plainly, and say what still works — a half-deaf tool that admits it is
    // half deaf is a different thing from one that pretends.
    log(`FAILED to watch ${root}: ${err.message}`);
    log('rules will NOT hot-reload — restart to pick up rule changes. Diagnostics themselves are unaffected.');
    return () => {};
  }

  watcher.on('error', (err) => log(`watch error on ${root}: ${err.message} — rule hot-reload may have stopped`));
  watcher.on('change', (_event, filename) => {
    if (!filename) return; // Some platforms omit it; nothing actionable without a name.
    const rel = filename.toString().split(path.sep).join('/');
    if (rel.split('/').some((seg) => IGNORED_SEGMENTS.has(seg))) return;
    if (!patterns.some((re) => re.test(rel))) return;

    dirty.add(path.join(root, rel));
    scheduleFlush({ flush, debounceMs, maxWaitMs, timers });
  });

  return () => {
    clearTimeout(timers.debounce);
    clearTimeout(timers.max);
    watcher.close();
  };
}
