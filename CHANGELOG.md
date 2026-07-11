# Changelog

All notable changes to `vp-astgrep` are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  registered; nothing in it knows what ast-grep is. The same unanswered request makes `csharp-lsp` and
  `elixir-lsp` — both in Anthropic's own marketplace — **hang outright** rather than merely go stale, so
  this is written to be extracted into its own plugin once a second one needs it.

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
  yourself* — exactly as **rust-analyzer** and **pyright** already do, which is why they are immune to
  this and ast-grep is not. It needs nothing from Anthropic. When it lands, this shim becomes dead code
  and `plugin.json` goes back to invoking `ast-grep` directly, dropping the Node requirement with it.
  Tracked in `UPSTREAM-brew--ast-grep.md`; **nothing has been filed upstream.**
- **Measured, and new information: Claude Code advertises `workspace.didChangeWatchedFiles.dynamicRegistration
  = undefined`.** No public dump of its LSP capabilities existed. Two consequences: (1) the shim's
  capability injection is *load-bearing*, not defensive — a spec-compliant server would otherwise
  correctly decline to register and the shim would see nothing; (2) **`rust-analyzer` / `pyright` / `gopls`
  / `clangd` are NOT broken in Claude Code** — they respect the capability and self-watch. An earlier
  draft of the upstream notes speculated they were silently broken; they are not, and the correction is
  recorded rather than quietly deleted.
- The shim makes the *server* current; it does not make Claude Code re-surface diagnostics on its own.
  Claude Code injects diagnostics after a **file edit**, so the honest UX is *edit a rule, then edit
  code, and the new rule applies.*
- `ast-grep/ast-grep#722` (open) is a sharp edge worth knowing: ast-grep **silently ignores an invalid
  rule** on reload, so saving half-written YAML makes diagnostics quietly vanish rather than error.

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
