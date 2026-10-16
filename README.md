# memory-vault

Personal long-term memory system. Local, portable, works with any agent that
speaks MCP.

Markdown files are the source of truth. One background process (the daemon,
`memoryd`) is the only writer. It keeps a rebuildable SQLite index and serves
hybrid search (keyword BM25 plus local embeddings) to any MCP agent. No memory
content leaves your machine unless you turn on capture (off by default). When
capture is ON, small redacted chat excerpts are sent to a triage model, either
Claude Haiku through your own local Claude CLI (no extra key) or OpenRouter, a
third-party AI service hosted in the United States, so a cheap
model can pull out candidate memories. Each candidate has two possible endings:
it is written straight into your memory, or it is thrown away. There is no
review list to work through. That is the only feature that sends any data off
your machine.

This is your own tool. It is not tied to any company.

## Status

Working local memory system. All six build increments are done: lexical search,
the single-writer daemon, hybrid search, the six MCP write tools with a safe
write pipeline, background capture, and the daily vault backup.

The project is not published to npm's public registry yet. You install it from
your clone with `npm link` (see the Quickstart).

## Zero install: the vault alone is already useful

You do not have to install anything to benefit from a vault. The memory is
plain markdown; share or copy the vault folder and any agent with file access
can use it today:

- Point the agent at `USER.md`, `MEMORY.md`, `PROJECT.md` and `daily/` for
  context, and let it grep the folder for lookups.
- You get readable context and keyword-level search with zero setup.
- What you do NOT get without the daemon: ranked hybrid search, trust labels
  and fencing, safe writes (hash checks, secret scan, budgets, backups), and
  capture. A hand edit has no safety rails.

The install below adds those. The folder stays the source of truth either way.

## Prerequisites

- Node 22 or newer.
- git.

## Quickstart

1. Clone this repo.

2. Set up the code with one command. Run this from `memory-daemon/`:

   ```
   cd memory-daemon
   npm run bootstrap
   ```

   This runs install, build, link and a health check, in that order, and makes
   the right call for your platform along the way. It prints each step as it
   runs, so you can see where it stops if something goes wrong. If `npm link`
   fails, for example from a permissions problem on macOS or Linux, the script
   keeps going and tells you the fallback command:
   `node dist/cli/memory.js <command>` instead of `memory <command>`. The last
   step runs the built-in `doctor` check and shows its output, including
   whether hybrid search is on.

   To see what it would do first, with no changes made, run
   `node bootstrap.mjs --dry-run` from the same folder.

   Manual alternative, if you want to run each step yourself:

   **macOS and Linux:**

   ```
   cd memory-daemon
   npm install
   npm run build
   ```

   **Windows:** plain `npm install` tries to compile `better-sqlite3` from
   source with node-gyp, which needs the Visual Studio C++ tools and often
   fails. Skip that compile with `--ignore-scripts`. This flag also skips the
   build step, so you MUST run `npm run build` after it, or there is no `dist/`
   folder and nothing can start:

   ```
   cd memory-daemon
   npm install --ignore-scripts
   npm run build
   node dist/cli/memory.js doctor
   ```

   The last line runs the built-in check. It confirms the build worked and tells
   you whether hybrid search is on. (`--ignore-scripts` also skips the embedding
   model setup, so search may start in keyword-only mode. `doctor` reports which
   mode is active; if it says hybrid search is off, follow the exact fix it
   prints. Keyword search works in the meantime.)

3. Put the `memory` command on your PATH. `npm run bootstrap` above already
   does this with `npm link`. Run it by hand only if you used the manual
   alternative, or if `npm link` failed during bootstrap and you fixed the
   permissions problem it reported:

   ```
   npm link
   ```

   After this, `memory` runs from any folder. If you skip this step, run the CLI
   as `node dist/cli/memory.js <command>` instead. That is the only fallback; the
   rest of these docs use the short `memory` form.

4. Set it up, and turn on automatic memory in Claude Code:

   ```
   memory init --hooks
   ```

   `memory init` picks a vault folder, seeds `USER.md` and `MEMORY.md`, writes
   your config, and prints the exact MCP registration line for this machine. It
   prints every path it writes to; read that output.

   Two things it changes that are easy to miss:

   - **The vault folder.** With no flag it uses `<your home folder>/memory-vault`
     (for example `C:\Users\you\memory-vault` on Windows). To choose a different
     folder, pass `--vault <path>`, for example
     `memory init --vault D:\vaults\memory`.
   - **Your Claude Code settings.** The `--hooks` flag edits your global Claude
     Code settings file, `~/.claude/settings.json` (on Windows,
     `C:\Users\you\.claude\settings.json`). It merges the memory hooks into that
     file and writes a `.bak` copy first, so you can undo it. To write the hooks
     into a different file, add `--settings <path>`. Leave off `--hooks` to make
     no change to any settings file; init just prints the hook block for you to
     paste by hand. With the hooks on, memory turns on by itself in Claude Code:
     it loads your memory at the start of a session and captures new facts in the
     background.

   If a `config.local.yml` file already exists in this repo root, it is read
   instead of the config `memory init` just wrote, and init prints a warning
   saying so. See "Where config comes from" in `memory-daemon/README.md`.

5. Connect your agent. Paste the block that `memory init` printed into your
   agent's MCP config. The next section shows the exact shape of that block, and
   how to connect more agents later.

That is enough to search and write memory from your agent.

Manual alternative to step 4: copy `config.example.yml` to `config.local.yml` in
this repo root and edit the vault path by hand. `memory init` does the same thing
for you and also prints the MCP line.

## Connect an agent

Any tool that speaks MCP can use this memory. Claude Code, Claude Desktop,
Cursor and other MCP clients all work the same way. You register one MCP server
named `memory`. Its command is `node` plus the absolute path to
`memory-daemon/dist/mcp/index.js` inside your clone.

`memory init` prints this block with your real path already filled in. Paste that
one if you still have it. If not, write it by hand, as shown here.

**Windows.** JSON needs two backslashes for each backslash in the path:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["C:\\Users\\you\\memory-vault\\memory-daemon\\dist\\mcp\\index.js"]
    }
  }
}
```

**macOS and Linux.** The same block, with forward slashes and no escaping:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/home/you/memory-vault/memory-daemon/dist/mcp/index.js"]
    }
  }
}
```

Replace the path with the real path to your clone. The path must be absolute. On
Windows the agent starts the server without a shell, so a relative path fails.

Where the block goes:

- Claude Code: `.mcp.json` in the project, or your user MCP config. The command
  `claude mcp add` does the same job with the same `node` command and absolute
  path.
- Claude Desktop: `claude_desktop_config.json`, under `mcpServers`.
- Cursor: `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every
  project.
- Any other MCP client: run the same command over stdio.

### The first call in a new session

The daemon starts on its own the first time an agent calls a memory tool. It also
builds the search index on that first start. So the first `memory_search` or
`memory_add` in a fresh session can answer that the daemon or the index is not
ready yet. This is normal. Wait a moment and make the same call once more. If the
same answer keeps coming back, run `memory doctor` in a terminal. It names what
is missing and prints the fix. If it says the index was not created yet, run
`memory index` once.

The "meaning" half of search is a local model. It needs about one minute to warm
up the first time. Until then search is keyword-only and may report
`degraded: lexical_only`. Full hybrid search turns on after the model is warm.

### Connect a second agent

You can have several agents connected at the same time. They all talk to the
same daemon, and that daemon stays the only writer. You do not start or stop
anything for a new agent.

Paste the same MCP block into the second agent. That is the whole step.

Each agent gets its vault from the folder it runs in. The memory server reads the
`.memory.yml` marker of that folder. So two agents running in two different repos
can use two different vaults, with one shared daemon. The next section explains
how to set that up.

### An agent that is not Claude Code

Claude Code has hooks. They load your memory at the start of a session and
capture new facts in the background. Other agents have no hooks, so they must be
told to use memory. Copy the block "System prompt for a non-Claude agent" from
`docs/agent-guide.md` into that agent's system prompt or custom instructions.

To connect an agent to one client's vault, follow the recipe at the end of the
next section.

## Use more than one vault

### What a vault is

A vault is one folder of Markdown files that holds memory. The system can read
and write more than one of them.

Every vault is self-contained. Each one holds its own `USER.md`, its own
`MEMORY.md`, its own `PROJECT.md`, its own daily log in `daily/` and its own
session transcripts in `sessions/`.

Every setup has a vault named `global`. That is your shared personal vault. It is
the default when a folder has no marker. It is **not** readable from everywhere:
a repo that belongs to another vault sees `global` only if you say so. The next
sections explain how.

### When you want a second vault

Add a second vault when memory must stay separate. One vault per client, or one
per project, is the usual choice. Work you save for one client is then not
visible in another client's repo. If all your work is personal, one vault is
enough and you can skip this section.

**Memory is separate by default.** An agent in a repo marked `vault: acme` starts
with empty memory. It does not know your profile, your preferences or your
general conventions until you let it read the shared vault. That is deliberate.
Two ways to fill that gap:

- Write the facts that matter into that vault, so the client vault carries its
  own profile and its own conventions.
- Or let that repo read your shared vault too, with one line in its marker. See
  "Share the personal vault with one repo" below.

### Add a vault

The folder must already exist. Create it first, then register it:

```
memory vault add acme D:\vaults\acme
```

A vault name may use letters, digits, `-` and `_`. It must start with a letter or
a digit, and it may be at most 32 characters long. The name `all` is not allowed,
because `--vault all` means "every vault".

The command writes into the config file that is really in use, and it keeps every
vault already listed there. It then prints the steps below, so you do not have to
remember them.

`memory init --force` is safe to run later. It replaces the config file, but it
keeps every vault the old file listed and prints their names, so a vault you
added here is not lost. The vault named on that run wins and becomes the default.
Plain `memory init` without `--force` still refuses to overwrite an existing
config. One case is worth knowing: if the old file is broken and cannot be read
as YAML, no vault can be kept from it. `--force` says so in its output, and you
then add the missing vaults again with `memory vault add`.

The daemon reads the config only when it starts. It does not see the new vault
until you restart it:

```
memory daemon stop
memory daemon start
```

There is one daemon for all your agents, so the restart affects all of them. Do
it when no agent is in the middle of a task. An agent that calls memory during
the restart gets a "daemon not available" answer and has to try again.

Then build the search index for the new vault:

```
memory index --vault acme
```

`memory vault add` also creates three curated files inside the vault folder:
`USER.md`, `MEMORY.md` and `PROJECT.md`. A vault needs all three, because a repo
pointed at this vault reads no other vault by default. Each file comes with
sections marked `<!-- auto -->`, which is what an agent write needs:

```markdown
# PROJECT

Notes about this project. Sections marked <!-- auto --> accept agent writes.

## Decisions <!-- auto -->

## Conventions <!-- auto -->
```

If the folder already has one of these files, that file is kept and nothing is
overwritten. The command prints which files it created and which it kept.

### Create the curated files in a vault you already have

A vault you registered before this change has none of the three files. Its first
write answers `FILE_NOT_FOUND`. One command fixes it:

```
memory vault seed acme
```

It creates only the files that are missing, and it never overwrites one that is
already there. It prints each file and says whether it was created or kept. Run
it as many times as you like.

`memory vault list` marks a vault that still needs it, so you do not have to
remember which ones are old. The shared `global` vault is never marked for
`PROJECT.md`: that file belongs to a project vault, and a write to `project` from
the shared vault is refused anyway.

### Point a repo at a vault

Create a file named `.memory.yml` at the root of the repo. It holds one line:

```yaml
vault: acme
```

This marker belongs to the folder, not to the agent. It is found by walking up
from the folder where the agent or the CLI runs, one parent at a time, until a
`.memory.yml` shows up. The first file found wins. So one marker at the root of a
repo covers every subfolder of that repo.

Create this file in every repo that belongs to that client.

A folder with no `.memory.yml` above it uses the default vault from the config.
In a normal setup that default is `global`, so an unmarked repo works with your
shared personal memory. `memory vault list` names the vault for the folder you
run it in. Nothing changes for you if you have only one vault.

### Share the personal vault with one repo

By default a marked repo reads its own vault and nothing else. To let it read
your shared `global` vault too, add one line to that repo's `.memory.yml`:

```yaml
vault: acme
share_global: true
```

That is the whole file. With `share_global: true`, a search in that repo reads
`acme` and `global`. Without the line, or with `share_global: false`, it reads
`acme` only.

Two points to keep in mind:

- Sharing is for **reading** only. A write from that repo still lands in `acme`.
  Nothing that repo saves can reach your personal vault.
- Sharing is per repo. Turning it on for one client's repo does not turn it on
  anywhere else.

### What each agent sees

An agent reads its own vault, and nothing else. An agent in a repo marked
`vault: acme` reads `acme`. It reads `global` as well only when that repo's
marker says `share_global: true`. It can never read a vault named `beta`, and
the memory tools never tell it that `beta` exists.

This is a privacy boundary, not only a way to stay organized. The memory tools
have no vault field and no sharing field at all, so an agent cannot ask for
another vault, cannot ask for everything, and cannot invite the shared vault in
by itself. The scope is decided on the server side, from the folder the agent
runs in. One limit is worth knowing: the boundary covers the memory tools. An
agent that can read any file on your machine can still open a vault folder
directly.

Writes follow the folder, always. Every note an agent saves in that repo goes to
that repo's vault: the project note, the fact about you, the general convention
and the line of the day. Nothing an agent writes goes to another vault.

To save a fact into your shared `global` vault, write it from a folder that uses
`global`. Either a folder with no `.memory.yml` at all, when `global` is your
config default, or a folder whose marker says `vault: global`. For example:

```
cd ~
memory add memory Conventions "Commit messages in English."
```

Session transcripts follow the folder too. When capture is on, it writes a
redacted copy of your chat sessions into `sessions/` inside the vault of the repo
the session ran in. A session in a repo marked `vault: acme` lands in the `acme`
vault, so an agent in another client's repo cannot search it. A repo with no
marker uses your default vault. A repo whose marker cannot be used writes no
transcript at all, because the system refuses to guess a vault.

There is no review inbox any more. A captured fact is either written straight
into your memory or thrown away in the same second, so no file collects quotes
from your sessions while it waits for you.

Capture stays off until you add an OpenRouter key, so none of this happens by
default. To remove wording afterwards, use `memory forget "<text>"
--purge-sessions`. That command scans the `sessions/` folder of every vault, so
it reaches a transcript wherever it landed.

Transcripts written before this rule existed are still in `global/sessions/`.
Nothing moves them for you. Move or delete them by hand if that matters to you.

### How you look across everything

You are the person at your own terminal, so you may look wider than any agent
can:

```
memory search "invoice format" --vault all
memory search "invoice format" --vault acme
```

`--vault all` searches every configured vault at once. `--vault <name>` searches
one named vault. With no flag, a search reads exactly what an agent here would
read: this folder's vault, plus `global` when this folder's marker says
`share_global: true`.

An agent cannot do this, on purpose. If an agent is ever tricked by text it
reads, it still cannot reach another client's memory.

### See what is configured

```
memory vault list
```

It prints three things:

- the config file in use, and why that file wins over the others,
- every configured vault with its folder, which one is the default in this
  folder, and a warning when a folder does not exist,
- the vaults a search in this folder will read, and whether the shared `global`
  vault is one of them and why.

Run it inside a repo when you want to be sure the marker works. `memory vault
list` reads the config file itself, so it shows a vault you just added even
before you restart the daemon. Your agents see that vault only after the restart.

### When something looks wrong

Two signs say that the marker in this folder could not be used:

- a search result carries a `scope_notice` field,
- a write fails with `VAULT_UNRESOLVED`.

Both mean the same thing. The `.memory.yml` here names a vault that is not
configured, or the file does not parse. The system does not guess. In that folder
a search finds nothing and every write is refused, so a note cannot land in the
wrong vault. Reading the shared vault instead is not an option any more, because
the shared vault needs an invitation and a broken marker cannot give one.

Fix it in one of three ways:

1. Add the missing vault with `memory vault add <name> <path>`, then restart the
   daemon.
2. Correct the vault name inside `.memory.yml`.
3. Delete `.memory.yml`, if this repo should use the default vault.

Then run `memory vault list` in that folder. Its last lines name the vaults a
search there reads now. What the agent should do with these two signals is in
`docs/agent-guide.md`.

### Recipe: connect an agent to a client vault

Everything above, in order. The example client is `acme`, its vault folder is
`D:\vaults\acme`, and its repo is `D:\code\acme-api`.

1. Create the folder `D:\vaults\acme`, then run:
   `memory vault add acme D:\vaults\acme`
   This registers the vault and creates `USER.md`, `MEMORY.md` and `PROJECT.md`
   inside `D:\vaults\acme` for you.
2. Restart the daemon: `memory daemon stop`, then `memory daemon start`
3. Build the index: `memory index --vault acme`
4. Create `D:\code\acme-api\.memory.yml` with the single line `vault: acme`
5. Register the memory MCP server in the agent you will run in that repo. See
   "Connect an agent" above.
6. From `D:\code\acme-api`, run `memory vault list`. Its last lines must say that
   a search there reads `acme`, and nothing else.

Now start the agent in `D:\code\acme-api`. It reads and writes the `acme` vault
only. Its session transcripts land in `D:\vaults\acme\sessions\`, not in your
shared vault.

That agent starts with empty memory. It does not know your profile or your
general conventions. If you want it to know them, add this second line to
`D:\code\acme-api\.memory.yml`:

```yaml
vault: acme
share_global: true
```

Then `memory vault list` in that folder says a search there reads `acme` and
`global`. Writes still go to `acme` only.

## Commands you will use most

| Task | Command |
|------|---------|
| Set up everything | `memory init [--hooks] [--vault <path>]` |
| Check the install | `memory doctor` |
| See the index and daemon state | `memory status` |
| Search | `memory search "<query>" [--k <n>] [--scope <s>] [--vault <name>] [--browse] [--json]` |
| Search every vault | `memory search "<query>" --vault all` |
| See everything remembered | `memory show [--all]` |
| Add a fact yourself | `memory add <user\|memory\|project> <section> "<text>"` |
| List the vaults, and the one used here | `memory vault list` |
| Add a vault | `memory vault add <name> <path>` |
| Create the curated files a vault is missing | `memory vault seed <name>` |
| Rebuild the search index | `memory index [--vault <name>]` |
| Control the daemon | `memory daemon start\|stop\|ping` |

`--scope` takes one of `all`, `curated`, `reservoir`, `meetings`, `daily`. The
full command list, with every flag, is in `memory-daemon/README.md`.

## Layout

| Path | What |
|------|------|
| `memory-daemon/` | The code: daemon, MCP proxy, CLI, hooks (Node + TypeScript) |
| `vault/` | The global personal vault: `USER.md`, `MEMORY.md`, `daily/`, and more |
| `config.example.yml` | Documented config template. Copy it to `config.local.yml`. |
| `.memory.yml` | Optional, one per repo, and not in this repo. It names the vault that repo uses, and may add `share_global: true`. See "Use more than one vault". |

Other vaults, for example one vault per client, live outside this repo. This repo
holds only what crosses every project: the code and the personal layer.

## Learn more

- `memory-daemon/README.md`: how to install, build and run, the full command
  list, where config is read from, MCP registration details, and the Windows
  install note. The human commands to see, edit, delete and audit your memory
  are there too: `memory show`, `memory log`, `memory forget`, and more.
- `docs/agent-guide.md`: how an agent should use the six memory tools, the safety
  rules it must follow, and what it should do when a search returns
  `scope_notice` or a write fails with `VAULT_UNRESOLVED`.
