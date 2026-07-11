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

ast-grep's server has **no file watcher of its own**. On `initialized` it sends the *client* a
`client/registerCapability` request, asking it to watch `**/*.{yml,yaml}` and report back via
`workspace/didChangeWatchedFiles`. Claude Code replies `-32601 "Unhandled method"` and watches nothing.

So the server is never told the rules changed, and **serves its startup rule set forever**.

The symptom is what makes this expensive: **document sync keeps working perfectly.** Edit a source file
and the server re-analyses it instantly, correct line numbers and all — while rule edits do nothing at
all. Two channels; only one is wired. So the plugin looks perfectly healthy, and you conclude your *rule*
is wrong rather than simply never loaded.

**Except it was never actually silent — and this is the part worth knowing.** ast-grep *notices* the
refusal and reports it, immediately, naming the exact cause:

```
[window/logMessage ERROR] Failed to register file watchers:
    Error { code: MethodNotFound, message: "Unhandled method client/registerCapability" }
```

That message never surfaces. Claude Code shows a server's *stderr* under `--debug`, but not its
`window/logMessage` — 72 KB of debug output from a live session contains not one, not even the routine
`INFO` lines the same server emits on every startup. So the explanation was there from the first
handshake, and the better part of a day still went into rediscovering it by hand. Filed, gently, as the
most useful thing to fix.

**Both sides are behaving correctly, which is the awkward part.** LSP makes dynamic registration opt-in —
*"Not all clients need to support dynamic capability registration. A client opts in via the
`dynamicRegistration` property"* — and Claude Code advertises that property as `undefined`. It doesn't
claim the capability, so it isn't obliged to provide it. ast-grep asks anyway without checking, which is
also permitted: `didChangeWatchedFiles` has **no static path at all**, so asking and being turned down is
a legitimate outcome, and ast-grep handles the refusal correctly. The gap is between the two designs, not
inside either one.

What ast-grep lacks is a **fallback**. **`rust-analyzer`** checks the capability, sees it absent, and
watches the files itself — `config.rs` gates its client-watching default behind
`did_change_watched_files_dynamic_registration()` and otherwise drops to `FilesWatcher::Server`. That is
the real fix: entirely server-side, and it would let this shim be deleted. See
`UPSTREAM-brew--ast-grep.md`.

*(An earlier version of this README also claimed **pyright** does this. **It does not** — its language
server checks the capability and correctly declines to register, but has no fallback at all; the real
OS-level watcher is wired only into the standalone CLI, never into `server.ts`. Pyright misses on-disk
changes in Claude Code exactly as ast-grep does. Corrected rather than quietly deleted.)*

Until then the client-side capability is absent and doesn't look imminent —
[`anthropics/claude-code#32595`](https://github.com/anthropics/claude-code/issues/32595) and its re-file
`#52693` are both closed as NOT_PLANNED. Hence the shim.

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
for. That's not ambition — it's simply less code than hardcoding ast-grep would be, and it keeps the shim
easy to delete when ast-grep no longer needs it.

`npm run check:reload` proves it end to end, and proves the bug first: it asserts the **bare** server
ignores a rule change, then that the same server behind the shim emits an **unprompted**
`publishDiagnostics` carrying the new rule's message — with no `didChange` and no request of any kind.

### What that looks like in practice

**Edit a rule. That's it.** The updated diagnostics surface immediately, against the code you already
have open — no restart, and no need to go and touch a source file to "wake it up".

The mechanism is worth knowing, because it explains the one case where nothing appears. Claude Code
surfaces diagnostics **after a file edit** — and editing the rule *is* a file edit, which is why saving a
rule is enough on its own. But if the rules change *without* an edit from Claude — you pull a branch, or
edit a rule in another editor — the server reloads correctly and quietly, and you will not see the new
findings until the next edit. Nothing is broken; the diagnostics are simply waiting for a moment to be
shown.

### One sharp edge — and it is not ast-grep's fault

**Save a syntactically broken rule and your diagnostics will quietly vanish.** Not because ast-grep is
silent about it — it isn't — but because Claude Code cannot hear it.

Reproduced against ast-grep 0.44.1: an invalid rule on reload produces **both** a `window/showMessage`
\[ERROR] *and* a `window/logMessage` \[ERROR] reading `Failed to load rules: Cannot parse rule …`, and the
last-known-good rules stay in effect. `window/showMessage` is the method LSP defines specifically for
*"show this to the user."*

**Claude Code has no handler for either.** It registers exactly one notification handler on a plugin
language server — `textDocument/publishDiagnostics` — and discards everything else at protocol dispatch.
So ast-grep's error report is produced, correctly, and goes nowhere.

*(An earlier version of this README blamed [`ast-grep#722`](https://github.com/ast-grep/ast-grep/issues/722)
for "silently ignoring invalid rules". That is **wrong on current versions** — #722's own reproduction no
longer reproduces, and ast-grep reports the failure on two channels. The maintainer who closed it saying
*"sounds like an LSP client feature to me"* was right.)*

If a rule stops firing for no reason, run `ast-grep scan`
on the CLI: a fresh process reads current rules and will actually tell you the rule is broken.

### Turning it off, and turning it up

| Env var | Effect |
|---|---|
| `LSP_SHIM_DISABLE=1` | Bypass the shim entirely; run `ast-grep lsp` unproxied. 0.3.1's behaviour, without downgrading. A shim in the hot path of every LSP message should always have an off switch that does not require shipping a fix. |
| `LSP_SHIM_DEBUG=1` | Trace what the shim is doing: the client's advertised capabilities, the globs it is watching, and a line per reload. |

**By default the shim is silent — but only about the things that are working.** Anything meaning it is
degraded or dead is *always* printed to stderr: the server binary missing from `PATH`, framing
collapsing to a raw pipe, and above all **a watcher that fails to attach** —

```
[lsp-shim] FAILED to watch /path/to/project: <reason>
[lsp-shim] rules will NOT hot-reload — restart to pick up rule changes. Diagnostics are unaffected.
```

That asymmetry isn't fussiness. This whole plugin exists because a failure was invisible: the server
reported it accurately over `window/logMessage`, that channel doesn't surface in Claude Code, and a
precise error report turned into "the rules just don't reload" — a day to rediagnose. Having just been on
the receiving end of that, the least this tool can do is not do it to you. A tool that says what it
cannot do is a very different thing from one that just goes quiet.

### It is a stopgap, and it is meant to die

**The shim is a bridge, not a product.** The real fix belongs in ast-grep, it is entirely server-side,
and it needs nothing from Anthropic:

> **When the client does not advertise `workspace.didChangeWatchedFiles.dynamicRegistration`, watch the
> rule files yourself.**

**`rust-analyzer` already does exactly this** — verified in `crates/rust-analyzer/src/config.rs`: its
`files.watcher` default of `Client` is gated on `did_change_watched_files_dynamic_registration()`, and
falls through to `FilesWatcher::Server` (a real `notify` watcher) when the capability is absent. Not a
manual opt-in — an automatic fallback. **gopls** shipped a server-side watcher in v0.22.0 but it defaults
to `off` and its source carries a literal `// TODO: support "auto" mode`, so the maintainers are building
toward the same thing and haven't automated the trigger yet.

Measured here: **Claude Code advertises that capability as `undefined`**, which is the honest thing for a
client that doesn't watch files. So the signal a fallback would key on is already sitting in `initialize`;
it just isn't consulted yet.

**Retirement trigger: ast-grep ships a self-watch fallback.** On that day this shim becomes dead code
and `plugin.json` goes back to invoking `ast-grep` directly — which also drops the Node requirement.
Tracked in `UPSTREAM-brew--ast-grep.md`. **Nothing has been filed upstream.**

Until then, one discipline keeps the stopgap cheap: **nothing in `bin/` knows what ast-grep is.** It
spawns `argv[0]` and watches the globs the *server* registered. That is not ambition — hardcoding
ast-grep would be strictly *more* code, and it would make the shim harder to delete later, not easier.

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

### `spy-lsp.mjs` — read the wire instead of believing claims about it

```
node spy-lsp.mjs ast-grep lsp -c ./sgconfig.yml   2> spy.log
```

A **passthrough spy**: it answers nothing, swallows nothing, changes nothing. It forwards every byte in
both directions verbatim and reports the conversation to stderr — the client's `initialize` capabilities,
every server→client request *and the client's literal answer*, and every notification.

It is the opposite of the shim, and that is the point. The shim is a *participant*: the moment it answers
a request on the client's behalf, you can no longer see what the client would have said. The spy is
deliberately inert, so what you observe is what the two ends actually do to each other.

**Point it at Claude Code and the entire bug reproduces in one run:**

```
[SPY] CLIENT CAPABILITIES (as sent in `initialize`) — for many clients, published nowhere:
[SPY]   {"workspace":{"configuration":false,"workspaceFolders":false},"textDocument":{…}}
[SPY] server -> client  NOTIFY   window/logMessage type=3 "server initialized!"
[SPY] server -> client  REQUEST  client/registerCapability  (id=0)
[SPY] client -> server  ERROR    client/registerCapability -> -32601 "Unhandled method"  (38ms)  ** THE CLIENT DECLINED **
[SPY] server -> client  NOTIFY   window/logMessage type=1 "Failed to register file watchers: …"
```

Read the last two lines together. **The server reports the failure, precisely and immediately** — and
Claude Code registers no handler for `window/logMessage`, so nobody ever sees it. That is the whole
investigation, in two lines, from a tool that took twenty minutes to write.

**Why it exists.** Everything this project got *wrong*, it got wrong by trusting a claim about the wire
instead of reading it. *"Claude Code replies `-32601`"* was asserted here for days on the strength of **a
byte-log in someone else's GitHub issue.** It happens to be true — but it could as easily have been
`{result: null}`, an accept-then-ignore, which would have made the client a promise-breaker rather than an
honest decliner and **inverted the entire upstream write-up.** Nine lines of spy settled it in one run.
The sibling claim that *"servers hang on the unanswered request"* was pure folklore, traceable to two
reports that inferred silence from symptoms **without a byte trace**. A spy is cheap. Hearsay about a
protocol is not.

**What it cannot tell you** — and this is structural, not a limitation of the script. A notification
carries no `id` and expects no reply, so a client that *displays* one and a client that *discards* one are
**byte-identical here**. The spy proves the server **sent** it. Proving the client **surfaced** it needs a
second, client-specific look at wherever that client routes such messages (for Claude Code:
`claude --debug-file`, where they turn out not to appear at all).

Set `SPY_BODIES=1` to dump full message bodies. To spy on the *real* client rather than a synthetic one,
put `spy-lsp.mjs` in a throwaway plugin's `lspServers.command` and run
`claude --plugin-dir <it> --debug-file <log>` — Claude Code surfaces a server's stderr, which is what this
rides. (Remember plugin LSP servers start **lazily**, on the first *edit* to a claimed extension.)

### Verifying it live, without publishing

`--plugin-dir` loads a plugin straight from a working copy for that session, and **takes precedence over
the installed marketplace copy of the same name** — so there is no need to uninstall or disable anything,
and nothing has to be pushed:

```
claude --plugin-dir /path/to/vp-astgrep --debug-file /tmp/cc.log
```

The shim writes its state to stderr, which Claude Code surfaces in the debug log:

```
[LSP SERVER …] [lsp-shim] client advertises workspace.didChangeWatchedFiles.dynamicRegistration = undefined
[LSP SERVER …] [lsp-shim] injected workspace.didChangeWatchedFiles.dynamicRegistration=true
[LSP SERVER …] [lsp-shim] watching /path/to/project for "**/*.{yml,yaml}"
[LSP SERVER …] [lsp-shim] reload: 1 watched file(s) changed        <- a rule changed; the server was told
```

**LSP servers start lazily**, on the first edit to a file whose extension the plugin claims — so grep the
log *after* editing something, not at startup. To see a reload you must edit code **first** (which starts
the server), *then* the rule: editing the rule first merely starts the server, which reads the new rule at
boot and proves nothing.

## License

MIT © [Pelle Wessman](https://kodfabrik.se/)
