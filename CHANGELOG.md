# Changelog

All notable changes to `vp-astgrep` are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.4.2 — 2026-07-11

**Docs only. No code changes — the shim is unchanged and still works.** An adversarial review of every
claim in this repo (against source, binaries and live reproduction, rather than issue titles and memory)
refuted four of them. All four had already shipped. They are corrected in place rather than deleted.

### Fixed — four claims that were wrong

- **❌ "rust-analyzer and pyright both self-watch when the client can't."** **pyright does not.** Its LSP
  server checks the capability and correctly declines to register — and then has *no fallback at all*; the
  real OS-level watcher (chokidar) is wired only into the standalone CLI, never `server.ts`. Pyright misses
  on-disk changes in Claude Code exactly as ast-grep does. **rust-analyzer is confirmed** (`config.rs` gates
  its `Client` default on `did_change_watched_files_dynamic_registration()` and otherwise drops to
  `FilesWatcher::Server`). **gopls** shipped a server-side watcher in v0.22.0 but it defaults to `off` and
  carries a literal `// TODO: support "auto" mode`. Honest claim: *one* strong precedent, plus a direction
  of travel — not an industry norm.

- **❌ "ast-grep silently ignores an invalid rule (#722)" — and this one inverts.** Written into the README,
  this CHANGELOG, a source comment and the upstream notes **on the strength of an issue title.** Reproduced
  against 0.44.1: an invalid rule emits **both** `window/showMessage` \[ERROR] *and* `window/logMessage`
  \[ERROR], and the last-known-good ruleset stays in effect. Not silent. #722's own reproduction no longer
  reproduces (ast-grep now derives a missing `id:` from the filename). **The silence is Claude Code's** — it
  registers no handler for either method. The maintainer who closed #722 with *"sounds like an LSP client
  feature to me"* was right, and we nearly filed a bug against ast-grep for the client's defect.

- **❌ "csharp-lsp and elixir-lsp hang, and both ship in Anthropic's marketplace."** Both halves false. The
  request *is* answered (`-32601`, measured on the wire), so a blocking server unblocks; the "hangs forever"
  language traces to two 2026-03/04 reports that inferred silence from symptoms **with no byte trace**, and
  was then propagated by a downstream plugin README. And `elixir-lsp` is third-party, not Anthropic's. The
  real failure is server-side handling of the *error response* (csharp-ls aborts its solution load; Roslyn
  throws; PowerShell times out at ~30s).

- **❌ "whether a dead server starves its extension is undocumented."** It is documented, and it splits three
  ways: registration-time config failure → **fixed in v2.1.205**; registers-then-dies → **still starved**
  (the router reads only index 0 and never fails over) — *which is ast-grep's case, so our narrow extension
  claim stays necessary*; two healthy servers → first-registered wins, by design.

### Added — the `window/*` finding, now confirmed at source

- Claude Code registers **exactly one** notification handler on a plugin LSP server —
  `textDocument/publishDiagnostics` — and one request handler, `workspace/configuration`. `window/logMessage`
  and `window/showMessage` exist in the binary **only as vendored protocol constants; there is no handler.**
  Dispatch is by method name *before params are read*, so a severity filter is structurally impossible and
  there is no headless-vs-interactive difference. **This is why nobody has reported it:** server→client
  *requests* get a loud `-32601` and are already filed; server→client *notifications* are discarded with **no
  artifact at all** — nothing to screenshot, nothing to grep.

## 0.4.1 — 2026-07-11

### Changed

- **The shim is silent by default — but only about the things that are working.** 0.4.0 narrated every
  session to stderr (the capability probe, the watched globs, a line per reload). A proxy in the hot path
  of every LSP message should not narrate itself to a user who did not ask. Those lines now require
  **`LSP_SHIM_DEBUG=1`**.

  **Faults are exempt, deliberately.** The server binary missing from `PATH`, framing collapsing to a raw
  pipe, and above all **a watcher that fails to attach** are printed *always*, with no flag:

  ```
  [lsp-shim] FAILED to watch /path/to/project: <reason>
  [lsp-shim] rules will NOT hot-reload — restart to pick up rule changes. Diagnostics are unaffected.
  ```

  That asymmetry is the whole point. This plugin exists because a failure was invisible: the server
  reported its refused registration accurately over `window/logMessage`, that channel doesn't surface in
  Claude Code, and a precise error report became "the rules just don't reload" — a day to rediagnose.
  Having just been on the receiving end of that, shipping a tool that fails quietly would be a poor way
  to repay it. Both halves are now asserted in `check:reload`: a healthy session (*including a reload*)
  prints **nothing**, and a broken one still speaks **without** `LSP_SHIM_DEBUG`. The second guard exists
  to stop a future maintainer — most likely me — quietly demoting a fault to `debug()`.

### Fixed

- A watch failure previously logged one bland line and did not say what the user had lost. It now states
  plainly that rules will not hot-reload, and that diagnostics themselves still work.

## 0.4.0 — 2026-07-11

**Rule hot-reload works.** 0.3.1 documented that it could not — this release retracts that limitation
by fixing it, rather than by re-describing it.

### Added

- **`bin/lsp-shim.mjs` — a stdio shim between Claude Code and the language server.** It answers the
  `client/registerCapability` request that Claude Code refuses to (it replies `-32601 "Unhandled
  method"`), reads the watcher globs out of that registration, watches them itself, and injects the
  `workspace/didChangeWatchedFiles` notification the client never sends. ast-grep then reloads its
  rules and re-publishes diagnostics for every open document on its own.

  **It is server-agnostic on purpose.** It spawns `argv[0]` and watches whatever globs the *server*
  registered; nothing in it knows what ast-grep is — that is simply less code than hardcoding ast-grep
  would be. (An earlier version of this entry claimed the same request makes `csharp-lsp` and `elixir-lsp`
  "hang outright", and that both ship in Anthropic's marketplace. **Both parts are false** — see 0.4.2.)

  Upstream is not going to fix this: `anthropics/claude-code#32595` and its re-file `#52693` are both
  closed as NOT_PLANNED.

- **`verify-lsp-reload.mjs`** (`npm run check:reload`) — proves the reload end to end, and proves the
  **bug** first: it asserts the *bare* server ignores an on-disk rule change, then that the same server
  behind the shim emits an **unprompted** `publishDiagnostics` carrying the new rule's message, with no
  `didChange` and no request of any kind. Establishing the RED baseline against the unproxied server is
  what stops the test passing vacuously.
- **`bin/lsp-framing.mjs` + `bin/glob-watch.mjs`**, unit-tested (`npm run check:unit`). Framing is
  hand-rolled — Claude Code git-clones plugins and never runs `npm install`, so a runtime dependency
  would not exist when the server starts. Zero deps is a hard constraint here, not a preference.
- **`LSP_SHIM_DISABLE=1`** bypasses the shim and runs the server unproxied — 0.3.1's behaviour at
  runtime, without downgrading. A shim in the hot path of every LSP message needs an off switch that
  does not require shipping a fix.

### Changed

- ⚠️ **BREAKING: Node ≥ 20 must now be on Claude Code's `PATH`.** The shim is a Node script, so the
  manifest's `command` is now `node` rather than `ast-grep`. **No node ⇒ no server ⇒ no diagnostics at
  all**, which is a *worse* failure than the stale rules this release fixes, so it is called out loudly
  in the README. The trap is `nvm`/`fnm`, which put node on your *shell's* `PATH` and not necessarily on
  the one Claude Code inherits. Pin **0.3.1** to avoid the dependency entirely.

### Notes

- **The shim is a stopgap, and it is meant to die.** The durable fix is server-side in ast-grep — *when
  the client does not advertise `didChangeWatchedFiles.dynamicRegistration`, watch the rule files
  yourself* — as **rust-analyzer** does. (This entry originally also credited **pyright**. It does not do
  this; see 0.4.2.) It needs nothing from Anthropic. When it lands, this shim becomes dead code
  and `plugin.json` goes back to invoking `ast-grep` directly, dropping the Node requirement with it.
  Tracked in `UPSTREAM-brew--ast-grep.md`; **nothing has been filed upstream.**
- **Measured, and new information: Claude Code advertises `workspace.didChangeWatchedFiles.dynamicRegistration
  = undefined`.** No public dump of its LSP capabilities existed. Two consequences: (1) the shim's
  capability injection is *load-bearing*, not defensive — a spec-compliant server would otherwise
  correctly decline to register and the shim would see nothing; (2) servers that *check* the capability
  degrade politely rather than loudly — though only **rust-analyzer** actually self-watches as a fallback
  (see 0.4.2; `pyright` does not, and we were wrong to say it did).
- **Correction (verified live, 2026-07-11): editing a rule is enough — no second edit needed.** The
  0.4.0/0.4.1 notes claimed the UX was *"edit a rule, then edit code, and the new rule applies"*. That
  undersold it. Editing the rule *is itself* a file edit, and Claude Code surfaces diagnostics after any
  edit, so the updated findings appear immediately against already-open code. The caveat only bites when
  the rules change with **no** edit from Claude (a `git pull`, or an edit made in another editor): the
  server reloads correctly and silently, and the new findings wait for the next edit to be shown.
- ~~`ast-grep/ast-grep#722`: ast-grep silently ignores an invalid rule on reload.~~ **RETRACTED in 0.4.2 —
  this is false.** ast-grep reports an invalid rule on *two* channels; Claude Code discards both.

## 0.1.0 — 2026-07-11

Initial release.

### Added

- **`lspServers` registration for the ast-grep language server** (`ast-grep lsp`, stdio). Rules in
  `.ast-grep/rules/*.yml` now produce diagnostics live, after each edit, instead of only on an
  `ast-grep scan` run. (The claim that rule files hot-reload was WRONG — see 0.3.1.)
- Claims the JavaScript family only (`.js`, `.mjs`, `.cjs`, `.jsx`). Deliberately does **not** claim
  `.ts`/`.tsx`: when two enabled LSP servers claim one extension the first registered wins and the
  others never start, so claiming TypeScript would risk silently disabling `typescript-lsp`.
- Passes `-c ${CLAUDE_PROJECT_DIR}/sgconfig.yml` explicitly. The server otherwise resolves the config
  from its working directory and hard-exits if absent — a known cross-editor failure.
- **`verify-lsp.mjs`** — a dependency-free stdio LSP client that drives the REAL server and asserts a
  violating buffer produces a diagnostic carrying the rule's id, **and that the fixed buffer clears
  it**. The second half is what makes it an oracle rather than a smoke test: a check that only asserts
  the error case cannot distinguish a working linter from one that fires on everything.

## 0.3.1 — 2026-07-11

### Fixed (documentation — a false claim, measured and retracted)

- **"Rule files are watched — edit a rule and diagnostics update without a restart" is FALSE in Claude
  Code.** It was inherited from ast-grep's docs, where it is true *for VSCode*, and shipped untested.

  ast-grep's server asks the **client** to watch `**/*.{yml,yaml}` for it, via a dynamic
  `workspace/didChangeWatchedFiles` registration — it has no watcher of its own. Claude Code's LSP
  client does not honour that, so the server is never told the rules changed. Nothing errors; it
  silently keeps its startup rule set.

  The symptom is worth knowing precisely, because it misleads: **document sync keeps working perfectly**
  — edit a file and the server re-analyses it instantly, with correct line numbers — while **rule edits
  have no effect at all**. Two channels; only one is wired. Established by changing a rule's message,
  waiting 25s, touching the file, and watching the server keep reporting the OLD message against
  FRESHLY-analysed code (the line number tracked the edit; the message did not).

  **Edit or add a rule ⇒ restart Claude Code.** `ast-grep scan` on the CLI is unaffected — a fresh
  process always reads current rules, which is the convenient way to iterate on a rule while writing it.

## 0.3.0 — 2026-07-11

### Added

- **Claims the web + config formats too — 15 extensions, up from 7.** Adds `.json` `.yaml` `.yml` `.md`
  and `.css` `.scss` `.html` `.htm`. These are the formats rules get written for next, and this is a
  plugin its author dogfoods; claiming them now means a new rule works the day it is written.

  Stated plainly, because it is a real trade and not a free lunch: **no *official* Claude Code language
  server claims those eight — but popular third-party ones exist for every one of them**
  (`yaml-language-server`, `marksman`, `vscode-json`/`css`/`html`). If one ever ships as a Claude Code
  plugin and you install it, one of the two will lose the extension, because the first server registered
  for an extension wins and the others never start. The official list tells you what is contested
  *today*; it cannot tell you what is contested *tomorrow*. The allowlist in `check-extensions.mjs` now
  carries the two tiers explicitly — **in use** vs **dogfood** — so the bet is legible rather than
  buried.

  Extensions ast-grep maps to the same language come as a set (`.yml` with `.yaml`, `.scss` with
  `.css`, `.htm` with `.html`); a partial claim would only be confusing.

The **hard** rule is unchanged and still enforced: never claim an extension owned by an official
language server (`.ts .tsx .py .rs .go .java .rb .php .c .cpp .h .cs .lua .kt .swift`). Verified the
guard still fires on a planted `.py` and on a planted `.tf`.

## 0.2.0 — 2026-07-11

### Added

- **Claims bash (`.sh` `.bash` `.zsh`) alongside the JavaScript family — 7 extensions, up from 4.**
  ast-grep is polyglot (28 languages) and v0.1.0 claimed only JavaScript, so `bash` rules — which real
  projects here actually have — got no live diagnostics at all.
- **`check-extensions.mjs`**, wired into `npm run check`, enforcing two rules and failing the build on
  either:
  1. **Never take an extension from an official language server.** When two enabled LSP servers claim
     one extension, the first registered wins and the others *never start*, so a greedy map would
     silently disable `pyright-lsp` / `rust-analyzer-lsp` / `gopls-lsp`. (`--refresh` re-derives the
     official claim list from the marketplace on the machine, so this cannot rot as Anthropic ships new
     servers.)
  2. **Claim only what you actually lint.** Stricter, and the load-bearing one. "Uncontested by the
     official marketplace" is a weaker guarantee than it sounds: popular servers exist for `.tf`,
     `.nix`, `.json`, `.yaml`, `.md`, `.css`, `.html` too, and any could ship as a third-party plugin
     tomorrow. The official list tells you what is contested *today*, not tomorrow. An extension with
     no rules behind it buys nothing and costs a language server someone may want. **Coverage is not
     the thing to maximise; blast radius is the thing to minimise.**

  An earlier draft of this release claimed 25 extensions on rule 1 alone. Rule 2 cut it to 7.

### Notes

Targeting **cannot** be made dynamic — checked, not assumed. Claude Code supports no wildcards, no
computed LSP config, no per-project override, and no way to influence collision precedence. A static map
can also never be *complete*: `customLanguages` in `sgconfig.yml` lets a project register a tree-sitter
grammar under arbitrary extensions no plugin-side map can anticipate.

The genuinely correct set is per-project — exactly the `language:` values in that project's own rules,
which *is* mechanically derivable — but there is no mechanism to express it. ast-grep's own VSCode
extension sidesteps the problem by claiming *every* file (`language: '*'`) and gating on `sgconfig.yml`
instead; Claude Code offers no equivalent.

Upstream detail worth recording: ast-grep's server **ignores the `languageId`** the client sends and
re-detects the language from the file path, so only the map's *keys* matter — the values are cosmetic.
