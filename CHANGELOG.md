# Changelog

All notable changes to `vp-astgrep` are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-07-11

Initial release.

### Added

- **`lspServers` registration for the ast-grep language server** (`ast-grep lsp`, stdio). Rules in
  `.ast-grep/rules/*.yml` now produce diagnostics live, after each edit, instead of only on an
  `ast-grep scan` run. Rule files are watched, so editing a rule hot-reloads it.
- Claims the JavaScript family only (`.js`, `.mjs`, `.cjs`, `.jsx`). Deliberately does **not** claim
  `.ts`/`.tsx`: when two enabled LSP servers claim one extension the first registered wins and the
  others never start, so claiming TypeScript would risk silently disabling `typescript-lsp`.
- Passes `-c ${CLAUDE_PROJECT_DIR}/sgconfig.yml` explicitly. The server otherwise resolves the config
  from its working directory and hard-exits if absent — a known cross-editor failure.
- **`verify-lsp.mjs`** — a dependency-free stdio LSP client that drives the REAL server and asserts a
  violating buffer produces a diagnostic carrying the rule's id, **and that the fixed buffer clears
  it**. The second half is what makes it an oracle rather than a smoke test: a check that only asserts
  the error case cannot distinguish a working linter from one that fires on everything.

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
