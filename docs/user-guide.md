# A second brain for your AI agents

Your AI already remembers a little. Claude Code keeps notes about your
preferences per project, plus a global instruction file. All of it lives
inside one tool, and none of it is your knowledge. What no
assistant gives you is a brain: your meetings, your people, your
decisions, and your past work, searchable by meaning, shared by every tool
you use, and owned by you. This system is that brain. It grows for years,
and the cost per session stays flat.

```mermaid
flowchart TB
    CC["Claude Code"]
    OBS["You, in Obsidian"]
    TERM["The terminal"]
    MCP["Any MCP agent"]
    subgraph BRAIN["ONE shared brain"]
        direction LR
        CORE["a small curated core<br/>who you are, your rules"]
        KNOW["everything you know<br/>meetings, topics, people,<br/>past sessions"]
    end
    CC <-->|"reads and writes<br/>the same brain"| BRAIN
    OBS <-->|"edits the same files<br/>directly"| BRAIN
    BRAIN <-->|"the same brain<br/>from the command line"| TERM
    BRAIN <-->|"the same brain<br/>over the open protocol"| MCP
    TAG["change the tool,<br/>keep your mind"]
    BRAIN -.-> TAG
    classDef green fill:#1a7f37,color:#fff,stroke:#116329
    classDef blue fill:#0969da,color:#fff,stroke:#0550ae
    classDef neutral fill:#57606a,color:#fff,stroke:#32383f
    class CC,OBS,TERM,MCP neutral
    class CORE,TAG green
    class KNOW blue
```

## At a glance

| Question | Short answer |
|---|---|
| What is this? | One long-term memory shared by all your AI agents |
| How fast is search? | By meaning, in any language, well under a second |
| What does a session pay? | A curated core near 5 KB, with a hard ceiling, forever |
| What leaves the machine? | One small redacted excerpt per capture, nothing else |

## Doesn't Claude Code already remember things?

Yes. It keeps small notes about your preferences, per project. Everything
below is what that built-in memory cannot do.

## Two memories, one brain

A small curated core: three files, about 5 KB with a hard ceiling, that
travel whole into every session. And the long-term brain: 160+ files and
10,000+ searchable chunks today, holding meetings, topics, people, and past
sessions. The core rides along; the brain waits on disk.

The core will feel familiar: Claude Code also injects notes when a session
starts. Two things are new here: a hard ceiling that keeps the cost flat
forever, and the same core serving every tool you use.

```mermaid
flowchart LR
    subgraph CORE["CONTEXT CORE: rides into every session, whole"]
        direction TB
        C1["3 files: who you are,<br/>durable facts, project rules"]
        C2["about 5 KB in total,<br/>a hard ceiling"]
    end
    subgraph BRAIN["LONG-TERM BRAIN: waits on disk"]
        direction TB
        B1["meetings, topics, people,<br/>work logs, past sessions"]
        B2["thousands of chunks indexed,<br/>grows without limit"]
    end
    CORE --> FLAT["cost per session:<br/>constant, flat forever"]
    BRAIN --> FIND["searched on demand:<br/>an answer in under a second"]
    BRAIN -.->|"a fact climbs into the core<br/>only when you ask"| CORE
    classDef green fill:#1a7f37,color:#fff,stroke:#116329
    classDef blue fill:#0969da,color:#fff,stroke:#0550ae
    class C1,C2,FLAT green
    class B1,B2,FIND blue
```

The same idea over time, with illustrative growth. First the brain: the
steep line is live searchable memory, the low gentle line is the archive
building up. Nothing is ever deleted.

```mermaid
xychart-beta
    title "The brain grows without limit (thousands of chunks)"
    x-axis ["month 0", "6", "12", "18", "24"]
    y-axis "thousands of chunks" 0 --> 40
    line [0, 10, 18, 27, 36]
    line [0, 0.5, 1, 2, 4]
```

And what a session pays for all of that: a flat line. The curated core has
a hard ceiling, so the cost per session never follows the growth.

```mermaid
xychart-beta
    title "What every session pays: flat forever"
    x-axis ["month 0", "6", "12", "18", "24"]
    y-axis "KB injected per session" 0 --> 10
    line [5, 5, 5, 5, 5]
```

## Which memory answers which question?

The rule is simple. Exactness reads the files: who you are and the rules of
the project are in the session before the first word. Relevance reads the
RAG index (the agent finds the right notes first, then answers from them):
keyword plus meaning plus recency, in any language, well under a second.

```mermaid
flowchart TD
    NEED["the agent needs memory"]
    NEED --> EX["it needs the EXACT text:<br/>exactness reads the files"]
    NEED --> RE["it needs the most RELEVANT fact:<br/>relevance reads the index"]
    EX --> O1["session start:<br/>the 3 core files, whole"]
    EX --> O2["changing a note:<br/>the note itself"]
    EX --> O3["every write:<br/>re-read from disk first"]
    RE --> O4["any question:<br/>what did we decide about X"]
    O1 --> FILES[("your markdown files<br/>the source of truth")]
    O2 --> FILES
    O3 --> FILES
    O4 --> RAG["hybrid search:<br/>by words and by meaning"]
    RAG --> IDX[("local index<br/>a rebuildable copy")]
    classDef green fill:#1a7f37,color:#fff,stroke:#116329
    classDef blue fill:#0969da,color:#fff,stroke:#0550ae
    classDef neutral fill:#57606a,color:#fff,stroke:#32383f
    class NEED,EX,RE,O1,O2,O3,O4 neutral
    class FILES green
    class RAG,IDX blue
```

One safety rule sits under every write: before changing a file, the system
re-reads it from disk and checks its fingerprint. If you edited that note
in Obsidian a moment earlier, the write backs off and your version stays.

## Why markdown files AND a database?

Because each does what the other cannot. The markdown files are the record:
yours to open in any editor, versioned in git, readable in twenty years, no
export and no lock-in. The database is the speed: a local SQLite index
holding the keyword tables and the meaning vectors, so a question over
thousands of chunks comes back in under a second. The index is disposable
on purpose: delete it and nothing is lost, it rebuilds from the files.

```mermaid
flowchart LR
    MD[("markdown files<br/>the RECORD: yours, editable,<br/>git history, portable")]
    DB[("SQLite index<br/>the SPEED: keywords and<br/>meaning vectors, local")]
    GONE["delete the index:<br/>nothing is lost,<br/>it rebuilds itself"]
    MD -->|"indexed again seconds<br/>after every change"| DB
    DB -.->|"never writes back:<br/>the files are the truth"| MD
    DB --- GONE
    classDef green fill:#1a7f37,color:#fff,stroke:#116329
    classDef blue fill:#0969da,color:#fff,stroke:#0550ae
    classDef gray fill:#32383f,color:#d0d7de,stroke:#57606a
    class MD green
    class DB blue
    class GONE gray
```

## What enters memory on its own?

Every 10 turns, capture reads the new part of the conversation and keeps
only the durable facts you said yourself. Meetings, tool output, and
documents never enter on their own: they stay searchable, and promoting
them is always your call. Every fact remembers who said it, so a
third-party line is read as a quote, never as an instruction.

```mermaid
flowchart TD
    SAID["something was said<br/>in the session"]
    SAID --> WHO{"did YOU say it?"}
    WHO -->|"no: meeting, tool output,<br/>document"| TP["NEVER enters alone<br/>the lock is code<br/>only your hand promotes it"]
    WHO -->|"yes"| DUR{"is it durable?<br/>a preference, a convention,<br/>a machine quirk"}
    DUR -->|"no: task talk, decisions,<br/>facts about people"| ASK["thrown away<br/>say add this to memory<br/>and it is saved"]
    DUR -->|"yes"| CONF{"is the confidence high?"}
    CONF -->|"no"| ASK
    CONF -->|"yes"| IN["enters your memory alone<br/>every next session knows it"]
    classDef green fill:#1a7f37,color:#fff,stroke:#116329
    classDef amber fill:#bf8700,color:#fff,stroke:#7d4e00
    classDef red fill:#cf222e,color:#fff,stroke:#82071e
    classDef neutral fill:#57606a,color:#fff,stroke:#32383f
    class SAID,WHO,DUR,CONF neutral
    class IN green
    class ASK amber
    class TP red
```

## What happens to a fact over the years?

A durable preference you state enters the core at the next capture pass,
minutes later, and every session after that is born knowing it. When the
core fills up, older facts move down into the
searchable brain; obsolete ones move to the archive. Nothing is deleted,
and the core stays near 5 KB forever, so the cost per session never grows.

```mermaid
flowchart TD
    T0["minute 0<br/>you say it once:<br/>I prefer snake_case"]
    T1["minutes later<br/>it enters the core:<br/>every future session<br/>is born knowing it"]
    T2["months later<br/>the core is full,<br/>it moves to the long-term brain:<br/>search still finds it"]
    T3["years later<br/>archived, out of the way:<br/>still on disk and in git,<br/>nothing is deleted"]
    T4["any day<br/>one manual step<br/>brings it back"]
    T0 -->|"capture picks it up"| T1
    T1 -->|"makes room,<br/>does not forget"| T2
    T2 -->|"marked obsolete"| T3
    T3 -.-> T4
    classDef green fill:#1a7f37,color:#fff,stroke:#116329
    classDef blue fill:#0969da,color:#fff,stroke:#0550ae
    classDef neutral fill:#57606a,color:#fff,stroke:#32383f
    class T0,T3 neutral
    class T1,T4 green
    class T2 blue
```

## Do projects share one memory?

Not by accident. Each repo can name its own vault in a small marker file;
with the marker, one client's work is invisible to another client's
sessions. A repo without a marker uses your default vault. The brain at the
top of this page is your personal one; a client project gets its own brain,
same machinery, never mixed. Your personal vault joins a project only by
explicit invitation, and even then it is read only.

```mermaid
flowchart TD
    RA["sessions in client A repo"]
    RB["sessions in client B repo"]
    MA["small marker file<br/>names vault A"]
    MB["small marker file<br/>names vault B"]
    VA[("vault A<br/>client A memory only")]
    VB[("vault B<br/>client B memory only")]
    PV[("your personal vault")]
    X["BLOCKED by design<br/>the tools have no vault choice,<br/>the folder decides"]
    RA --> MA
    MA --> VA
    RB --> MB
    MB --> VB
    RA -.->|"tries to read client B"| X
    X -.- VB
    PV -.->|"joins a project only by<br/>explicit invite, and read only"| VA
    classDef green fill:#1a7f37,color:#fff,stroke:#116329
    classDef red fill:#cf222e,color:#fff,stroke:#82071e
    classDef neutral fill:#57606a,color:#fff,stroke:#32383f
    class RA,RB,MA,MB neutral
    class VA,VB,PV green
    class X red
```

## Where does my data live?

On your machine. Plain markdown you can open, edit, and version in git; the
index and every search run locally; and every file the system writes keeps
its last 20 versions as automatic backups.
The one exception: per capture, one small excerpt with secrets removed goes
out for triage, on your own Claude account.

```mermaid
flowchart LR
    subgraph PC["YOUR machine: everything lives here"]
        direction TB
        F[("your markdown files<br/>open them, edit them,<br/>version them in git")]
        E["embeddings<br/>computed locally"]
        I[("search index<br/>a rebuildable copy")]
        S["every search runs locally"]
        D["the memory service<br/>starts itself, safe to kill"]
        NOTE["no cloud holds your memory:<br/>turn capture off and<br/>nothing leaves at all"]
        F -->|"indexed in seconds"| I
        E --> I
        I --> S
    end
    CLOUD["triage on your own<br/>Claude account"]
    D -->|"the ONE small arrow out:<br/>a redacted conversation excerpt,<br/>every 10 turns, optional"| CLOUD
    CLOUD -->|"durable fact candidates<br/>come back"| D
    classDef green fill:#1a7f37,color:#fff,stroke:#116329
    classDef blue fill:#0969da,color:#fff,stroke:#0550ae
    classDef purple fill:#8250df,color:#fff,stroke:#6639ba
    classDef amber fill:#bf8700,color:#fff,stroke:#7d4e00
    class F,NOTE green
    class I,S blue
    class E,D purple
    class CLOUD amber
```

For how it works inside, see [architecture.md](architecture.md).
