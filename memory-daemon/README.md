# memory-daemon

Personal long-term memory system. Single write daemon, thin MCP proxy, and local
hybrid search (BM25 + embeddings) over Obsidian vaults. Markdown files are the
source of truth; the SQLite index is rebuildable and lives outside the vault.

Status: all six increments done (working local memory system). Search is hybrid (BM25 + local embeddings fused
with RRF, identifier bypass, recency; degrades to lexical if the model is
cold). Writes are safe: all six MCP tools exist (`memory_search`,
`memory_get`, `memory_add`, `memory_replace`, `memory_remove`,
`daily_append`), every write goes through the single pipeline (serial queue,
re-read from disk, 3-level hash precondition, secret scan, denylist,
injection scan, simulation, budget with terminal outcome, atomic write with
.bak backup) and is re-indexed immediately. The frozen per-session snapshot
is served by the daemon; `memory snapshot --out <file>` exports it for
platforms without hooks. Capture (Increment 5) and daily vault backup (Increment 6)
are done too; see "Capture" below.

Claude Code hooks make memory automatic: `SessionStart` ->
`dist/hooks/session-start.js` (frozen snapshot + retrieval push), `Stop` ->
`dist/hooks/turn-counter.js` (capture every 10 turns), `SessionEnd` ->
`dist/hooks/session-end.js` (best-effort flush). All via
`node <absolute path>`; all exit 0 silently on failure. `memory init --hooks`
registers all three for you (it merges into any existing `hooks` block in
`<home>/.claude/settings.json` and writes a `.bak` first; `--settings <path>`
targets a different file, `--no-hooks` just prints the block to paste). On a
terminal, plain `memory init` asks before touching settings.

Capture: needs `openrouter.api_key` in `../config.local.yml` (model:
`openai/gpt-oss-120b`, chosen 2026-07-21). A candidate has exactly two
outcomes. It is auto-promoted, which writes it straight into the curated layer
through the normal pipeline, or it is discarded on the spot. There is no review
queue (removed 2026-07-28): a discarded candidate is written to no file, kept
in no SQLite row, and cannot be reached by search. It is only logged at debug
level, with the reason, for a developer reading the daemon log. Auto-promotion
needs a safe class (`style_preference`, `flow_convention`, `env_gotcha`), the
`session_extract` origin and confidence at or above 0.8, plus the extra source
turn checks in `capture/index.ts`. Third-party content never auto-promotes.
Transcripts enter `vault/sessions/` only after secret redaction (blocking
requirement).

## Plans

Two documents in `../docs/` explain the design:

- `architecture.md`: the parts, the search path, and the write path, in diagrams.
- `implementation-plan.md`: the build record, with tool contracts, SQLite DDL, the
  write pipeline order, and the search constants.

## Layout

Three bins: `memoryd` (daemon), `memory-mcp` (MCP proxy), `memory` (CLI).
Config (including the OpenRouter key) lives in `../config.local.yml` at the
repo root, kept out of Git. Legacy fallback: `%APPDATA%\memory\config.yml`. The
SQLite index lives in `%LOCALAPPDATA%\memory\index\`. Vaults: `../vault/`
(global, the shared personal one), plus any other vault you configure (for
example an Obsidian work vault). Each vault is self-contained and is readable
only from a folder that points at it.

## Where config comes from

The daemon reads ONE config file. It checks these sources in order and uses the
FIRST one it finds:

1. The path in the `MEMORY_CONFIG` environment variable, if that variable is set.
2. `config.local.yml` in the repo root (the `memory-vault` folder), if it exists.
3. `config.yml` in the OS config directory, if it exists:
   - Windows: `%APPDATA%\memory\config.yml`
   - macOS: `~/Library/Application Support/memory/config.yml`
   - Linux: `$XDG_CONFIG_HOME/memory/config.yml`, else `~/.config/memory/config.yml`

Footgun to know about: `memory init` writes source 3 (the OS config directory).
But if a `config.local.yml` exists in the repo root (source 2), that file wins,
and the config `memory init` wrote is read by nobody. So if you re-scope a vault
by editing the wrong file, nothing changes. `memory init` prints a warning when
this shadowing happens, naming both files.

To force one specific file no matter what, set `MEMORY_CONFIG` to its absolute
path. That beats both source 2 and source 3.

The OpenRouter API key (the capture secret) resolves on its own separate order,
so the secret can stay out of the repo tree: the `OPENROUTER_API_KEY`
environment variable first, then `config.yml` in the OS config directory, then
the repo-root `config.local.yml`. No real key found means capture stays OFF and
no data leaves the machine.

## Setup

Prerequisites (do these once, before the setup flow):

- **Node 22** (`.nvmrc`). `better-sqlite3 13.0.1` ships N-API prebuilds that also
  load on newer Node, but the pinned toolchain is 22. On Windows you can use a
  portable Node 22 build (a zip file, no installer): unpack it to a folder of
  your choice, for example `C:\tools\node-v22`, and put that folder first on
  `PATH` for npm work in this package.
- **Install and build** (all platforms):

  ```
  npm install
  npm run build
  ```

  `npm install` fetches dependencies and, through the `prepare` script, builds
  `dist/` for you. `npm run build` rebuilds after any code change. Do not skip
  the build: the MCP entry and the CLI both run from `dist/`.

  **Stop the daemon before you rebuild.** A build can bring a new database
  migration with it. The first command that opens the index in write mode runs
  that migration, and a daemon still running the old code would then be talking
  to a database it no longer matches. The safe order is always:

  ```
  memory daemon stop
  npm run build
  memory daemon start
  ```

  **Windows only, if `better-sqlite3` fails to build:** use
  `npm install --ignore-scripts` instead. Plain `npm install` triggers npm's
  default `node-gyp rebuild`, which needs Visual Studio C++; the bundled prebuilt
  binary (`prebuilds/win32-x64.node`) makes that build unnecessary. But
  `--ignore-scripts` also skips onnxruntime-node's postinstall and the `prepare`
  build, so hybrid search turns OFF (search stays keyword-only) and no `dist/` is
  produced. After it, build by hand and confirm the search mode:

  ```
  npm install --ignore-scripts
  npm run build
  node dist/cli/memory.js doctor   # shows whether hybrid search is on
  ```

- **Put `memory` on your PATH** (one time, from this directory):

  ```
  npm link
  ```

  After this, `memory <command>` runs from any folder. Without it, call the CLI
  as `node dist/cli/memory.js <command>`. That is the only fallback; the setup
  flow and command table below use the short `memory` form.

Setup flow:

1. **`memory init`**, one command that configures everything:

   ```
   memory init
   ```

   It picks a vault folder, seeds `USER.md` and `MEMORY.md`, writes the config,
   makes the index dir, and prints the exact MCP registration line for this
   machine. On a terminal it also asks two or three short questions to seed your
   first real facts, and offers to register the Claude Code hooks (memory turns
   on automatically). Add `--hooks` to register them non-interactively, or
   `--no-hooks` to only print the block to paste. Manual alternative: copy
   `../config.example.yml` to `../config.local.yml` and edit the vault path by
   hand.
2. Paste the printed line into your agent's MCP config (see "MCP" below). For a
   non-Claude agent, also paste the system-prompt block from
   `../docs/agent-guide.md` so the agent uses memory on its own.
3. Confirm the install: `memory doctor`.

## Commands

Build and test:

| Task | Command |
|------|---------|
| Install deps | `npm install` (Windows fallback: `npm install --ignore-scripts`, see Setup) |
| Type check | `npm run typecheck` |
| Build | `npm run build` (tsc + copies `schema.sql`/migrations into `dist/`) |
| Tests | `npm test` (unit + integration, LF and CRLF variants) |

Set up and run:

| Task | Command |
|------|---------|
| Set up (vault + config + MCP line) | `memory init` (add `--hooks` to wire Claude Code; `--vault <path>` to choose the folder) |
| List the vaults, and the one used in this folder | `memory vault list` |
| Add a vault (keeps the ones already configured) | `memory vault add <name> <path>` |
| Create the curated files a registered vault is missing | `memory vault seed <name>` |
| Index vaults | `memory index [--vault <name>]` (via daemon when it is alive) |
| Search | `memory search "your query" [--k n] [--scope s] [--vault <name>] [--browse] [--json]` |
| Search every vault at once (human only) | `memory search "your query" --vault all` |
| Index + daemon status | `memory status` |
| Daemon control | `memory daemon start\|stop\|ping` |
| Environment check | `memory doctor` |

Multi-vault setup, in human steps: `../README.md`, section "Use more than one
vault". Short version: `memory vault add <name> <path>`, restart the daemon
(`memory daemon stop`, then `memory daemon start`, because config is read only at
boot), `memory index --vault <name>`, then a `.memory.yml` file at the root of
each repo holding the single line `vault: <name>`.

The read rule, in four cases:

- No `.memory.yml`: the caller reads the config default vault. In a one-vault
  setup that is `global`, so nothing changes for a single-vault user.
- `vault: acme`: the caller reads `acme`, and nothing else. A repo starts with
  empty memory, on purpose.
- `vault: acme` plus `share_global: true`: the caller reads `acme` and `global`.
  Reading only. A write from that repo still lands in `acme`.
- A marker that cannot be honoured (unknown vault name, or broken YAML): the
  caller reads NOTHING, and every write is refused with `VAULT_UNRESOLVED`. The
  search response explains it in `scope_notice`.

Only the CLI can widen, with `--vault all`. Every vault is self-contained: it
holds its own `USER.md`, `MEMORY.md`, `PROJECT.md`, `daily/` and `sessions/`, and
`memory vault add` seeds the three curated files for you.

A vault registered before that seeding existed has none of those files, so its
first write answers `FILE_NOT_FOUND`. `memory vault seed <name>` creates the
missing ones, using the same seed text, and never overwrites a file that is there.
`memory vault list` marks the vaults that still need it. The shared `global` vault
needs no `PROJECT.md`, so it is never marked for that file.

See, edit, and audit your own memory (human commands):

| Task | Command |
|------|---------|
| See everything remembered | `memory show [--all] [--json]` |
| Read a curated file | `memory get <user\|memory\|project> [section] [--hashes]` |
| Add a fact yourself | `memory add <file> <section> "<text>"` |
| Edit a curated entry | `memory edit <file> <section> --match "<old>" --text "<new>"` |
| Delete a curated entry (honestly) | `memory forget "<text>" [--yes] [--purge-sessions]` |
| Audit trail: who wrote what, and when | `memory log [--limit n] [--json]` |
| Export the frozen session briefing | `memory snapshot [--out <file>]` |

Housekeeping:

| Task | Command |
|------|---------|
| Back up the vault now (commits it to local Git) | `memory backup` |
| Clear the rebuildable index (keeps everything in the vault) | `memory reset [--all] [--yes]` |
| Remove the system (keeps your vault) | `memory uninstall [--purge-vault] [--yes]` |

Daemon facts: pipe `\\.\pipe\memory-vault.v1.<username>` (single formula in
`core/ipc-address.ts`); a second instance exits with code 0 (on Windows the
cross-process bind error is EACCES, not EADDRINUSE); logs go to
`%LOCALAPPDATA%\memory\logs\memoryd.log` (synchronous destination, because the
duplicate-instance path exits before an async one would flush).

Embedding facts: model cache in `%LOCALAPPDATA%\memory\models`
(`node scripts/fetch-model.mjs` pre-downloads); a real vault of 2349
chunks embeds in ~3.5 min; warm queries add ~50-100 ms.
`node scripts/scan-corpus.mjs` prints the injection-scan false-positive
baseline (2026-07-21: 0 of 92 real files fired). Real-ONNX tests run with
`MEMORY_TEST_ONNX=1 npm run test:integration`.

## MCP (Claude Code)

Register the server with absolute paths (Claude Code spawns without a shell on
Windows, so `node` + absolute `.js` path is required). The block below is an
EXAMPLE only. Do not paste it as-is: `<your-clone>` is a placeholder and the
forward slashes fail on Windows. Use the block `memory init` prints instead. It
has your real absolute path already filled in, with backslashes on Windows:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["<your-clone>/memory-daemon/dist/mcp/index.js"]
    }
  }
}
```

Replace `<your-clone>` with the absolute path to your checkout if you ever fill
this in by hand, but the simplest path is to paste exactly what `memory init`
prints.

The server exposes all six tools: `memory_search`, `memory_get`, `memory_add`,
`memory_replace`, `memory_remove`, and `daily_append`. Search is read-only;
writes go through the daemon's single pipeline. See `docs/agent-guide.md` for
how an agent should use them.
