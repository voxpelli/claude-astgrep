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

## 0.2.0 — 2026-07-11

### Added

- **Claims 25 extensions, up from 4.** ast-grep is polyglot (28 languages); v0.1.0 claimed only the
  JavaScript family, which meant `bash` rules — used by real projects — got no live diagnostics at all.
- **`check-extensions.mjs`**, wired into `npm run check`. Claude Code requires a *static*
  `extensionToLanguage` map and, when two enabled LSP servers claim one extension, **the first
  registered wins and the others never start**. So every extension claimed is one that may be taken
  away from a real language server. The guard enforces the rule: **claim only what no official Claude
  Code language server wants — plus the JavaScript family, a deliberate and documented contest with
  `typescript-lsp`.** `--refresh` re-derives the official claim list from the marketplace on the
  machine, so the rule cannot rot as Anthropic ships new servers.

### Notes

Targeting **cannot** be made dynamic, and this was checked rather than assumed: Claude Code supports no
wildcards, no computed LSP config, no per-project override, and no way to influence collision
precedence. A static map also can never be *complete* — `customLanguages` in `sgconfig.yml` lets a
project register a tree-sitter grammar under arbitrary extensions no plugin-side map can anticipate.

The correct set is per-project (exactly the `language:` values in that project's own rules, which is
mechanically derivable) — but there is no mechanism to express that. ast-grep's own VSCode extension
sidesteps the problem by claiming *every* file (`language: '*'`) and gating on `sgconfig.yml`; Claude
Code offers no equivalent.
