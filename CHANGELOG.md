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
