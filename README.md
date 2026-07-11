# vp-astgrep

Live [ast-grep](https://ast-grep.github.io/) structural-lint diagnostics in Claude Code, via the
ast-grep language server.

Your `.ast-grep/rules/*.yml` already run on `ast-grep scan`. This makes them run **as the code is
written** — a violation surfaces in-context right after the edit, instead of minutes later on a
`check` run or in CI.

## Why

A convention written in a comment enforces nothing.

The rule that motivated this plugin was born when a file's own header said *"import it, don't re-roll
it"* — and six call sites re-rolled it anyway, for months, past code review. An ast-grep rule caught
all six, plus a seventh that a hand-written grep had missed (the grep keyed on an identifier; the rule
keyed on the *shape*).

That is the case for structural rules. This plugin is the case for making them **immediate**.

## Install

```
/plugin marketplace add voxpelli/vp-claude
/plugin install vp-astgrep@vp-plugins
```

Requires the `ast-grep` binary on `$PATH`:

```
brew install ast-grep      # or: npm i -g @ast-grep/cli, cargo install ast-grep
```

**And, since 0.4.0, Node ≥ 20 on `$PATH`** — the language server now runs behind a small stdio shim
(see below), and the shim is a Node script. This is a real new requirement and worth stating bluntly:

> **No `node` on Claude Code's `PATH` ⇒ the server does not start ⇒ you get no diagnostics at all.**
> That is a *worse* failure than the stale rules 0.4.0 fixes, so it is the one thing to check first.

The trap is `nvm`/`fnm`: they put `node` on the `PATH` of your *shell*, not of your desktop session. So
`node -v` working in a terminal does **not** guarantee Claude Code can see it — if you launched Claude
Code from Spotlight or the Dock rather than from that shell, it may not. If diagnostics vanish after
upgrading, run `claude --debug` and look for a spawn failure on `node`; launching Claude Code from a
shell where `node -v` works is the quickest fix.

If you would rather not take the Node dependency, **pin `0.3.1`** — it invokes `ast-grep` directly, and
its only cost is that rule edits need a restart. You can also keep 0.4.0 and set
`LSP_SHIM_DISABLE=1`, which bypasses the shim and reverts to exactly 0.3.1's behaviour at runtime.

## Requirements — read this before filing a bug

**Your project must have an `sgconfig.yml` in its root.** The ast-grep language server hard-exits
without one:

```
Error: No ast-grep project configuration is found.
```

So in a repo with no `sgconfig.yml`, this plugin is a **no-op** — the server fails to start, Claude
Code skips it, and you get no diagnostics. That is expected, not a defect. A minimal config:

```yaml
# sgconfig.yml
ruleDirs:
  - .ast-grep/rules
```

Run `claude --debug` to see language-server startup errors.

## What it registers

```jsonc
"lspServers": {
  "ast-grep": {
    "command": "node",
    "args": [
      "${CLAUDE_PLUGIN_ROOT}/bin/lsp-shim.mjs",   // <- the shim, since 0.4.0
      "ast-grep", "lsp", "-c", "${CLAUDE_PROJECT_DIR}/sgconfig.yml"
    ],
    "extensionToLanguage": { ".js": "javascript", /* …14 more, see below */ }
  }
}
```

**The explicit `-c` is load-bearing.** The server otherwise resolves `sgconfig.yml` from its working
directory and exits if it isn't there; passing the path makes it independent of whatever cwd the
client happens to use. This exact race is a known cross-editor failure mode.

## Rule hot-reload, and the shim that makes it work

**Edit a rule, then edit some code, and the new rule applies. No restart.** That is new in 0.4.0, and
0.3.1 shipped the opposite as a documented limitation — this section is a retraction as much as a
feature note.

### The bug it works around

ast-grep's server has **no file watcher of its own**. Instead it does the spec-correct thing: on
`initialized` it sends the *client* a `client/registerCapability` request, asking it to watch
`**/*.{yml,yaml}` and report back via `workspace/didChangeWatchedFiles`. The LSP spec **requires the
client to reply**. Claude Code replies `-32601 "Unhandled method"` and watches nothing.

So the server is never told the rules changed, and **serves its startup rule set forever**.

The symptom is what makes this expensive: **document sync keeps working perfectly.** Edit a source file
and the server re-analyses it instantly, correct line numbers and all — while rule edits do nothing at
all. Two channels; only one is wired. The plugin looks healthy while being half deaf, and you conclude
your *rule* is wrong rather than unloaded.

This is a client limitation, not an ast-grep one — hot-reload genuinely works in VSCode. And it is not
being fixed: [`anthropics/claude-code#32595`](https://github.com/anthropics/claude-code/issues/32595)
and its re-file `#52693` are both **closed as NOT_PLANNED**. Which is what turns a workaround into the
only path.

### What the shim does

`bin/lsp-shim.mjs` sits between the two over stdio and answers the request the client won't:

```
Claude Code  <--stdio-->  lsp-shim  <--stdio-->  ast-grep lsp
```

1. It forwards every message **verbatim**, in both directions. (It parses frames to inspect them, but
   forwards the original bytes — a proxy that re-serialises what it relays is a proxy that can silently
   rewrite it.)
2. It intercepts `client/registerCapability`, swallows it, and sends the server the `{ id, result: null }`
   reply it is owed.
3. It reads the watcher globs **out of that registration** and watches them itself.
4. On a change it injects the `workspace/didChangeWatchedFiles` notification Claude Code never sends.
   ast-grep reloads its rules and re-publishes diagnostics for every open document on its own.

**It knows nothing about ast-grep.** It spawns `argv[0]`; it watches whatever globs the *server* asked
for. That is deliberate — the same shim would unbreak `csharp-lsp` and `elixir-lsp`, which are shipped
in Anthropic's own marketplace and, unlike ast-grep, **block** on that unanswered request and hang
outright. It is written to be extracted into its own plugin once a second one needs it.

`npm run check:reload` proves it end to end, and proves the bug first: it asserts the **bare** server
ignores a rule change, then that the same server behind the shim emits an **unprompted**
`publishDiagnostics` carrying the new rule's message — with no `didChange` and no request of any kind.

### What it does *not* do

It makes the **server** current; it does not make Claude Code re-surface diagnostics spontaneously.
Claude Code injects diagnostics into context **after a file edit**. So the honest description of the
UX is: *edit a rule, then edit code, and the new rule applies.* Not: *edit a rule and watch findings
appear on their own.*

### One sharp edge

[`ast-grep/ast-grep#722`](https://github.com/ast-grep/ast-grep/issues/722) (open): on reload, ast-grep
**silently ignores an invalid rule** — no error, no warning. So saving a half-written YAML rule can make
diagnostics quietly *vanish* rather than error. If a rule stops firing for no reason, run `ast-grep scan`
on the CLI: a fresh process reads current rules and will actually tell you the rule is broken.

### Turning it off

`LSP_SHIM_DISABLE=1` bypasses the shim entirely and runs `ast-grep lsp` unproxied — 0.3.1's behaviour,
without downgrading. It exists because a shim in the hot path of every LSP message should always have
an off switch that does not require shipping a fix.

## Which file types it claims, and why that is a rule rather than a taste

ast-grep is polyglot — it supports **28 languages**. This plugin claims **15 extensions**, and stops
there on purpose.

Claude Code requires a **static** `extensionToLanguage` map: no wildcards, no globs, no computed
config, no per-project override, and no way to influence precedence. And when two enabled LSP servers
claim the same extension, **the first registered wins and the others never start**
([plugins reference](https://code.claude.com/docs/en/plugins-reference)). So **every extension this
plugin claims is one it may be taking away from a real language server.** Coverage is not the thing to
maximise here — **blast radius is the thing to minimise.**

> **The rule: claim what you lint, or realistically will. Nothing else.**

| Tier | Extensions | Why |
|---|---|---|
| **In use** | `.js .mjs .cjs .jsx` · `.sh .bash .zsh` | The `language:` values the served projects' rules actually declare today |
| **Dogfood** | `.json .yaml .yml .md` · `.css .scss .html .htm` | Web + config formats rules get written for next. An eyes-open bet, not a free lunch — see below |
| **Never** | `.ts .tsx .py .rs .go .java .rb .php .c .cpp .h .cs .lua .kt .swift` | All owned by official language servers |

Extensions that ast-grep maps to the **same** language come as a set — `.yml` with `.yaml`, `.scss`
with `.css`, `.htm` with `.html`. A partial claim would just be a confusing one.

**The dogfood tier is a real trade, so here it is plainly.** No *official* Claude Code server claims
those eight. But popular third-party servers exist for all of them — `yaml-language-server`, `marksman`,
`vscode-json` / `css` / `html`. If one ever ships as a Claude Code plugin and you install it, one of the
two will lose the extension. **The official list tells you what is contested today; it cannot tell you
what is contested tomorrow.** This plugin accepts that risk for its own dogfooding; if you would rather
not, delete those entries from `plugin.json` and `ALLOWED` — it is a two-line change.

**Deliberately contested:** `.js .mjs .cjs .jsx` — `typescript-lsp` claims these too. We claim them
anyway, because JavaScript structural rules are this plugin's reason to exist. **If you run
`typescript-lsp` as well, the two may be mutually exclusive on `.js`.** `/plugin` names the winner.

**Never claimed** is the hard rule, not a preference: claiming those would silently disable
`pyright-lsp` / `rust-analyzer-lsp` / `gopls-lsp` / `jdtls-lsp`. **A plugin that quietly breaks another
plugin is the worst kind of plugin.**

`check-extensions.mjs` enforces both rules on every `npm run check` and fails the build on a violation.
Its `--refresh` flag re-derives the official claim list from the marketplace on your machine, so the
hard rule cannot quietly rot as Anthropic ships new language servers.

### Adding a language

Add a **rule** for it first, then widen `ALLOWED` in `check-extensions.mjs` and the map in
`plugin.json`. Never the other way round — and check first whether a real language server wants that
extension, because you will be taking it from them.

### Why it can't be dynamic

The right set is genuinely **per-project** — it is exactly the set of `language:` values in your own
`.ast-grep/rules/*.yml`, and it is trivially derivable from them. But Claude Code has no mechanism to
compute or override an LSP config at load time, so a static map is the only option. Worse, a static map
can never be *complete*: `customLanguages` in `sgconfig.yml` lets a project register its own tree-sitter
grammar under **arbitrary** extensions, which no plugin-side map can anticipate.

If you need a language this plugin does not claim, fork it and add the extension — that is a one-line
change, and you are then making the collision trade-off knowingly, for your own setup.

(Two upstream details worth knowing: ast-grep's language server **ignores the `languageId`** the client
sends and re-detects the language from the file path, so only the *keys* of the map matter — the values
are cosmetic. And ast-grep's own VSCode extension sidesteps all of this by claiming **every** file
(`language: '*'`) and gating on `sgconfig.yml` instead; Claude Code offers no equivalent.)

## Not a replacement for `ast-grep scan`

`ast-grep` is an unpinned, external binary. A contributor without it installed gets **no diagnostics,
silently**. So keep `ast-grep scan` in your `check`/CI script as the enforcement gate — this plugin is
a **feedback** layer, never the contract layer.

## Verifying it works

```
npm run check          # all of the below
```

| Check | What it proves |
|---|---|
| `check:lsp` | Drives the real server over stdio: a buffer violating one of *your* rules produces a diagnostic carrying that rule's id — **and the fixed buffer clears it**. The second half is what makes it an oracle; a check that only asserts the error case cannot tell a working linter from one that fires on everything. |
| `check:reload` | Rule hot-reload, end to end. Asserts the **bare** server ignores a rule change (the bug), then that the shim flips it. |
| `check:unit` | The framing and watcher internals — byte-vs-char `Content-Length`, streams split mid-header, malformed headers degrading to a raw pipe instead of wedging. |
| `check:extensions` | That this plugin claims no extension an official language server owns. `--refresh` re-derives that list from the marketplace on your machine, so the rule cannot quietly rot. |

`node verify-lsp.mjs [path/to/project]` also runs standalone against any project with an `sgconfig.yml`.

## License

MIT © [Pelle Wessman](https://kodfabrik.se/)
