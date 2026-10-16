# Open-source roadmap

How to turn this project into a broadly adopted open-source product: local
agent memory that resists poisoning.

Rewritten 2026-07-23 after a competitor panel and a technical audit. The old
roadmap led with "local-first markdown memory". That headline is now taken by
several bigger projects (see Competitive position). This version leads with
security instead, and fixes technical facts the old roadmap got wrong.

---

## Goal and positioning

**One-line pitch: local agent memory that can't be poisoned.**

The wedge is security. The category name for the risk is OWASP ASI06:2026,
"Memory and Context Poisoning": an attacker plants text in an agent's memory,
and later that text is injected back into a model as if it were trusted, so it
steers the agent. Most memory products ignore this. This one is built around it.

What "can't be poisoned" means here, stated honestly. It is defense in depth,
not a magic guarantee. It rests on five concrete controls this codebase already
has:

1. **Untrusted-content fence.** Any text from a third party (meeting notes, tool
   output) is returned wrapped in a single tagged block with a random nonce and
   breakout neutralization, marked "reference, not instructions".
2. **Provenance gating.** Every fact carries an origin stamped by the parser,
   not self-declared. Third-party content never auto-promotes to the
   always-injected layer. Human approval for it is permanent and locked in code.
3. **Secret redaction.** A secret scan blocks writes in every layer and masks
   secrets before any transcript enters the vault.
4. **Injection scan.** Text is scanned at index time and at write time; only
   high-precision rules block, and only for non-human content in the curated
   layer, to keep false alarms low.
5. **Capture is off by default.** The one feature that sends data off the
   machine (triage of transcripts to an LLM) ships disabled. The user turns it
   on and adds their own key. With it off, zero data leaves the machine.

Local-first, plain markdown, Obsidian, and MCP are still true and still matter.
But they are now the reassurance ("your data stays yours, in files you own"),
not the headline. Every competitor has those. None credibly has the security
posture.

Distribution model, decided with the owner on 2026-07-23:

- **Local-first, self-hosted MCP server.** Each person runs it on their own
  machine. No hosted service. No per-platform connectors. No one else holds the
  data.
- **Broad adoption is the goal.** This is a product for many users, not a
  personal tool. Success is real installs by strangers, not stars.
- **Validate before polish.** Ship a lean, working thing to a small group of
  real users first. Build installers, a website, and a demo video only after
  those users confirm it works and matters.

---

## How it reaches every platform

- **MCP is the connector.** One MCP server works on every agent that speaks the
  Model Context Protocol: Claude Code, Claude Desktop, Cursor, Cline, Continue,
  VS Code, Zed, and more. One line in the agent's config points at it. Proven on
  2026-07-23: Claude Code and Claude Desktop used the same daemon.
- **The CLI is the fallback** for tools that do not speak MCP. Any tool can shell
  out to `memory search`.
- **A Claude skill is optional.** It packages "how to use it" for Claude users.
  It sits on top of MCP; it is not the core.
- We do **not** build one connector per platform. We do **not** host anyone's
  data.

---

## Phases

Order matters. Phase 0 does two jobs at once: make the product run on a
stranger's machine, and make the "can't be poisoned" claim actually true. Both
are foundation. Packaging, alpha users, and polish come only after a hard gate
proves a stranger can install and connect.

A separate proof workstream runs in parallel the whole time (see "Proof
workstream" below). It produces the evidence behind the security claim.

### Phase 0 — Make it run anywhere AND make the claim true

Two tracks. Both must pass before anything ships.

**Track A: cross-platform runnability.** Today one machine's layout is baked in;
a stranger cannot run it.

- **Fix the stale-socket crash first (the number-one blocker).** On macOS and
  Linux a crashed daemon leaves a dead Unix socket file behind. The current code
  reads `EADDRINUSE` as "another daemon is alive" and steps aside. Result: memory
  is permanently dead until the user deletes a file they do not know exists.
  Windows named pipes do not have this bug (the pipe dies with the process). Fix
  on Unix: on `EADDRINUSE`, probe the socket; if no one answers, unlink it and
  listen again. Cover it with a crash-recovery test (kill the daemon, leave the
  socket, assert the next start recovers). Nothing else in Phase 0 matters if a
  crash bricks the product.
- Remove all hardcoded paths from `config.ts` (the repo path and the owner's
  vault paths). First run works with no config: sane defaults, then the user picks the
  vault.
- Cross-platform IPC: named pipe on Windows, Unix domain socket on macOS and
  Linux, with the crash-recovery behavior above on each.
- Cross-platform locations for the index, config, logs, and model cache: the
  right per-OS folder, not only `%LOCALAPPDATA%`.
- Do not depend on a fixed Node install path. Require Node 22 or newer.

**Track B: security hardening that backs the headline.** Details live in a
companion document, `docs/security-hardening-plan.md` (to be written); do not
duplicate it here. This roadmap only records that the following must be proven,
not just present, before launch:

- The untrusted-content fence holds against breakout attempts (nonce, tag close,
  system-prompt markers).
- Third-party content cannot reach the always-injected layer by any path,
  including consolidation and merge (provenance stays sticky, weakest origin
  wins).
- The secret scan blocks in every layer and redacts before commit, verified on a
  corpus with a low false-alarm baseline.
- The injection scan's blocking rules fire on real attacks and stay quiet on
  the owner's own legitimate memory.
- Capture ships off by default; with it off, a network trace shows zero outbound
  traffic.

Done criterion for Phase 0: a stranger clones, runs, and the daemon survives a
crash; the five security controls each have a passing adversarial test.

### Phase 1 — First-run setup

- `memory init`: one command. Pick the vault, write the config, create the
  index, download the embedding model, and print the exact MCP setup line for
  the user's platform.
- `memory doctor`: check Node, the native modules, and that the daemon starts.
  **It must run a real embedding inference, not just check that a file exists.**
  Today, if the model or `onnxruntime-node` is missing, search silently drops to
  word-only (lexical) results and the user is never told. Silent downgrade is a
  top reason people quietly abandon a tool. `doctor` and `init` must run one
  real inference and, if it fails, say so loudly and explain the fix.
- The embedding model downloads on first use and is cached. The size and the
  wait get a clear message.

### Gate — Prove first-connect on a matrix (before packaging)

Do not package or invite users until a fresh machine, per row, can install the
product and complete one real search and one real write from a real agent.

Matrix rows (operating system by CPU):

| Target | Hybrid search | Note |
|---|---|---|
| Windows x64 | full | named pipe, no stale-socket bug |
| macOS arm64 (Apple Silicon) | full | primary Mac target |
| macOS x64 (Intel) | **lexical only** | `onnxruntime-node` ships no Intel-Mac binary; must degrade loudly, not crash |
| Linux x64 (glibc) | full | |
| Linux arm64 (glibc) | full | |
| Linux musl / Alpine | **lexical only** | `onnxruntime-node` ships no musl binary; same loud-degrade rule |

Agents to test the first connect on, per platform where available: Claude Code,
Claude Desktop, Cursor, Cline, VS Code.

Gate passes when every row either does full hybrid search or degrades to word-
only search with a clear, visible message (never a silent drop, never a crash),
and the first agent connects on the first try. Record which of the 6 targets get
full hybrid search and which are word-only; that table becomes part of the docs.

### Phase 2 — Package for the alpha (minimal)

Just enough to hand to real users. Not the polished launch.

- Publish to npm so `npm i -g` and `npx` work.
- **The public install must NOT use `--ignore-scripts`.** `onnxruntime-node` has
  a postinstall step that downloads its native binary; `--ignore-scripts`
  silently skips it and leaves search word-only. (The development machine uses
  `--ignore-scripts` for a local reason; that is a local workaround, never the
  public path.)
- `better-sqlite3` needs no special handling: version 13.0.1 ships prebuilt
  binaries for all 8 build targets, has no postinstall step, and is unaffected by
  `--ignore-scripts`. It is low risk. (The old roadmap wrongly grouped it with
  the risky module.)
- Confirm the six matrix rows install cleanly from npm, with the two lexical-only
  rows degrading loudly.

### Phase 3 — Private alpha (validation, before any polish)

The point of the whole "validate before polish" decision.

- Recruit 5 to 20 real users who already use Obsidian with Claude Code or Cursor.
  Their existing markdown vaults are the test.
- Watch the first connect, the first search, the first captured memory, and the
  security behavior on their real data.
- Success signals to collect: they install without help; search beats their
  current Obsidian search; nothing leaks; they keep it after a week.
- Only when these hold do we spend effort on installers, a website, and a video.

### Phase 4 — Polish and public launch

Only after the alpha validates.

- Standalone binaries per OS for users without Node.
- Installers per OS (Windows, macOS, Linux).
- A landing page and docs site. Lead with the security story and ASI06. The
  current `docs/` are the seed.
- A security page: exactly what stays local, what can leave (only triage
  snippets, only if the user turns capture on and adds a key), the fence, secret
  redaction, provenance, the poisoning benchmark result.
- A short demo video and an example Claude skill.
- `CONTRIBUTING`, issue templates, and CI (type-check and tests on every push,
  run across the matrix).

### Proof workstream (runs in parallel, feeds the launch)

Evidence, not adjectives. The security claim and the retrieval quality both need
numbers before the public launch.

- **Memory-poisoning benchmark.** Build a small, repeatable test set of poisoning
  attacks (planted instructions in meeting notes and tool output, secret
  exfiltration attempts, fence-breakout payloads). Measure how many the controls
  block. Publish the score. This is the core proof behind "can't be poisoned",
  and it must be honest about what still gets through.
- **LoCoMo.** Run the public long-conversation memory benchmark (LoCoMo) to show
  retrieval quality is competitive, so security is not an excuse for a weak
  memory. Report the number next to the competitors' published numbers.

---

## Decisions still open (owner)

1. **Project name — a rename is needed, not optional.** The current name collides
   with a cloud-memory competitor and is generic. It also fights the new
   positioning: it signals storage, not safety. Criteria for the new name: (a)
   unclaimed on npm, GitHub, and as a domain, all three; (b) signals trust and
   security, not storage or "vault/notes"; (c) short and easy to type in a config
   line. Pick before the alpha, so the npm package and repo are named once.
2. **License.** MIT, Apache-2.0, or other. Apache-2.0 adds a patent grant, which
   can matter for a security product. Decide before publishing to npm.
3. **Ship shape.** npm package first (Phase 2), standalone binary and installers
   later (Phase 4). Confirm this staging, and confirm whether the alpha gets npm
   only or also a simple installer.

---

## Competitive position (honest)

The core idea here is not new. A panel and an audit established this; the
roadmap reflects it rather than hides it.

- **The concept is commoditized.** "Shared, growing memory for agents, with
  RAG-style search, over MCP" is a crowded space:
  - **Basic Memory** — about 3,500 GitHub stars. Markdown, local, hybrid search,
    MCP, plus a paid cloud tier. Almost the same shape as this project.
  - **mem0 / OpenMemory** — about 61,500 GitHub stars. Hybrid plus graph memory,
    a full curation loop, local and cloud.
  - **A long tail of 400 or more** similar projects.
- **Curation is not a differentiator.** mem0 already does extraction, dedup,
  conflict resolution, and decay. Our curation loop is table stakes, not an edge.
- **The one unoccupied spot is security-first, inside our niche.** No credible
  player combines strong poisoning defense (injection defense, secret redaction,
  provenance gating, an untrusted-content fence, permanent human approval with no
  third-party auto-promote) with the markdown / Obsidian / local / MCP niche.
  That intersection is the wedge, and it is the only one.
- **Speed matters.** The broader "secure agent memory" angle is filling with
  early, thin projects (for example memwarden, OWASP Agent Memory Guard, and a
  cluster of new near-empty ASI06 repositories). Most are vaporware today, but
  the label is being claimed. We have a working implementation now; the window to
  plant the flag is short.

Blunt summary: we win only if security is real, proven, and the headline. On
every other axis we are one of hundreds.

---

## Hardest parts and risks

Corrected against the audit. The old roadmap had two of these facts wrong.

1. **Stale Unix socket after a crash (the number-one blocker).** On macOS and
   Linux, a crashed daemon leaves a socket file; the code treats `EADDRINUSE` as
   "peer alive" and never recovers, so memory is dead until the user deletes an
   unknown file. Fix first, with a probe-then-unlink-then-relisten recovery and a
   crash-recovery test. Windows named pipes are fine.
2. **`onnxruntime-node` 1.27.0 is the real native-module risk.** It has no
   binary for Intel Mac (darwin/x64) and none for musl/Alpine, and it runs a
   postinstall downloader that `--ignore-scripts` silently breaks. Consequences:
   the public install must not use `--ignore-scripts`; two matrix rows are
   word-only by necessity; and the failure mode must be a loud, clear message.
3. **`better-sqlite3` 13.0.1 is low risk (the old roadmap overstated it).** It
   ships prebuilt binaries for all 8 targets, has no postinstall, and is
   unaffected by `--ignore-scripts`. Do not spend effort here.
4. **Silent lexical-only degradation is a top adoption killer.** If the model or
   `onnxruntime-node` is missing, search quietly drops to word-only and `memory
   doctor` does not even test the model. A user thinks the product works and gets
   worse results with no warning. Fix: `doctor` and `init` run one real inference
   and warn loudly on failure; the matrix gate forbids any silent drop.
5. **Cross-platform first-run and locations.** Config, index, logs, and the model
   cache need the correct per-OS folder. Hardcoded Windows paths block everyone
   else. Covered by Phase 0 Track A and enforced by the matrix gate.
6. **First-run model download.** Size and wait need a clear message and a cache,
   or first impressions suffer on slow or corporate networks.
