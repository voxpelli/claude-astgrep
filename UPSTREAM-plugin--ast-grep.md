# Upstream: `ast-grep/agent-skill` (the official ast-grep Claude Code plugin)

The ast-grep project ships a Claude Code plugin. It is **skills-only** — it teaches the agent to write
ast-grep rules and shell out to the CLI. It registers **no `lspServers`**, so ast-grep's own language
server, which the project builds and ships, is not wired into Claude Code by the project's own plugin.
(Its issue #1, *"Distribute as a Claude Code Plugin"*, is closed.)

## Feature Requests

- **Register the ast-grep language server via `lspServers`** (2026-07-11) — The plugin currently gives
  the agent knowledge of ast-grep but not *feedback* from it: rules fire when the agent chooses to run
  `ast-grep scan`, not when code is written. Claude Code supports `lspServers` in a plugin manifest, and
  `ast-grep lsp` works with it — rules produce live diagnostics in-context after each edit. This is a
  manifest addition, not new code.
  The reason it is not a one-liner, and the reason this entry exists rather than a drive-by PR: doing it
  safely requires answers ast-grep's docs do not have (see Upstream Opportunities).
  Ownership: upstream · Workaround: full — `voxpelli/claude-astgrep` does it.

## Bugs

*No entries yet.*

## Upstream Opportunities

- **Contribute the LSP manifest, the extension-collision rule, and the verifier** (2026-07-11) — Three
  things were built here that the official plugin would need, and that are not obvious enough to expect
  a contributor to rediscover:

  1. **The collision rule.** In Claude Code, when two enabled LSP servers claim the same file extension,
     *the first registered wins and the others never start* — and registration order is undocumented.
     ast-grep is polyglot (28 languages), so the tempting move is to claim everything; that would
     **silently disable `pyright-lsp` / `rust-analyzer-lsp` / `gopls-lsp`** for anyone who installs it.
     The rule we settled on is *claim what you lint, nothing else*, enforced by a check that fails the
     build and re-derives the official-server claim list from the local marketplace so it cannot rot.
     **Coverage is not the thing to maximise; blast radius is the thing to minimise.** An official
     ast-grep plugin would be the *most* likely to get this wrong, because for upstream, claiming all 28
     languages looks like completeness rather than like a trap.
  2. **The hot-reload shim.** Claude Code never answers `client/registerCapability`, so ast-grep's rule
     watchers are never registered and the server serves its startup rule set forever. Without a shim, an
     official LSP plugin would ship a feature where *editing a rule does nothing* — the single most
     confusing possible first experience of it. See `UPSTREAM-claude-code.md` and
     `UPSTREAM-brew--ast-grep.md`; a server-side self-watch fallback would make the shim unnecessary and
     is the better long-term fix.
  3. **The verifier.** A dependency-free stdio LSP client that drives the real server and asserts a
     violating buffer produces a diagnostic carrying the rule's id **and that the fixed buffer clears
     it** — a check that only asserts the error case cannot tell a working linter from one that fires on
     everything.

  Also worth upstreaming as docs: `guide/tools/editors.html` lists nvim/coc/helix/emacs and not Claude
  Code, and the `sgconfig.yml`-or-die behaviour is not called out for editor integrators.
  Source: `voxpelli/claude-astgrep` (0.4.0) · Merge readiness: direct
  Ownership: us · Workaround: full — published as a standalone plugin.
