# Tier ranking: kill condition and baseline (2026-07-29)

Outcome of the 2026-07-29 design debate about the processing-layer criticism.
Phase 1 is DONE: every chunk carries a density `tier` (`curated`, `processed`,
`raw`), search results expose it, and the ranking change was applied on 2026-09-08. The tier
is a ranking signal only: it never touches the trust fence, never touches
auto-promotion, and never overrides origin.

## Kill condition (written before measuring)

A ranking change (down-weighting `raw` in fusion, and preferring `processed`
in the per-file cap) is justified only if the 10-query baseline shows BOTH:

1. `raw` chunks hold at least 40 percent of the top-6 slots overall.
2. In at least 3 of the 10 queries, a `raw` chunk outranks a `processed`
   chunk from the same file.

And after any future weight change, the fenced share of the top-6 must not
rise above this baseline. If it rises, the weight is rejected.

## Baseline result (measured 2026-07-29, no ranking change active)

| Metric | Value | Threshold | Met? |
|---|---|---|---|
| Raw share of top-6 slots | 31 of 54 slots, 57 percent | at least 40 percent | yes |
| Queries where raw outranks same-file processed | 3 of 10 | at least 3 | yes |
| Fenced share of top-6 | 54 of 54, 100 percent | baseline, must not rise | recorded |

Corpus at measurement time: 10,758 chunks, of which 10,102 raw, 642
processed, 14 curated. The fenced share being 100 percent also shows these
meeting-shaped queries never surface a curated bullet today; worth watching
when the weight lands.

Verdict: both gates met. The ranking change is approved by the data and
scheduled for later, per the 2026-07-29 decision. The July measurement
script and its queries were not kept; the later query set is described
below. All numbers in this document were measured on the owner's private
vaults.

## Applied (2026-09-08)

What changed: `SEARCH_DEFAULTS.TIER_RAW_FACTOR = 0.7` in `src/index/search/search.ts`. In the fusion step, the fused score of a `raw` chunk (verbatim transcript or session copy) is multiplied by 0.7. Setting it to 1.0 turns the change off. The trust fence, the identifier bypass, auto-promotion and origin are untouched.

What was NOT applied: the "prefer processed in the per-file cap" half. The plan reviewer showed that a preference inside the cap deletes a hit instead of moving it: a processed chunk far down the list would remove a strong raw chunk of the same file from the top-k and from every scroll page. On the query set used, no query had a raw hit ranked above a processed hit of the same file before the change, so there was nothing for the cap to fix. Dropped for good on 2026-09-10, owner's decision.

### Why a new query set

The 10 queries of the July baseline were lost with the scratchpad that held the measurement script, and the July session transcript is gone. The corpus also grew from 10,758 chunks to 36,794 chunks. So a new fixed set was measured on 2026-09-08, before and after, on the same index generation, in one process. The script is `memory-daemon/scripts/tier-measure.mjs` and lives in the repo now. It opens the index read-only, builds the vector channel, and runs every arm back to back; the chunk count was 36,794 at the start and at the end of the sweep.

### The queries (k = 6)

Ten meeting-shaped queries on a work vault, plus a curated-shaped set of 5. The queries touch private notes and are not published. `tier-measure.mjs` ships with neutral example queries; replace them with queries from your own vault.

Identifier bypass in this set: 8 of the 10 queries contain a canonical name from `Topics/_registry.md`, so the exact-match bypass fired on them. Bypass hits enter with an infinite score and are the same in every arm: 18 of the 60 slots are bypass slots, 3 of them tier raw, and no factor can move them. The before and after comparison is still valid, because those 18 slots are identical across arms, but the number of slots the factor could act on is 42, not 60. Five words or more only prevents `query_kind: identifier` and the vector channel skip; it does not prevent the bypass.

Curated-shaped set (5): three queries on the work vault and two on the global vault. They ask for a style preference, the owner's role, which repos belong to a project, and the rules for writing durable facts to memory.

### Sweep result (top 6 of the 10 meeting queries, 60 slots)

| Factor | Raw slots | Processed slots | Curated slots | Fenced slots | External-root slots | Queries where raw outranks same-file processed |
|---|---|---|---|---|---|---|
| 1.0 (before) | 15 of 60, 25 percent | 45 | 0 | 60 of 60, 100 percent | 10 of 60, 16.7 percent | 0 of 10 |
| 0.7 (chosen) | 7 of 60, 11.7 percent | 53 | 0 | 60 of 60, 100 percent | 12 of 60, 20 percent | 0 of 10 |
| 0.5 | 5 of 60, 8.3 percent | 55 | 0 | 60 of 60, 100 percent | 12 of 60, 20 percent | 0 of 10 |

Notes on the gates. The July kill condition would not be met by this query set on today's corpus: raw held 25 percent of the slots, not 40 percent, and raw never outranked a same-file processed chunk. The July gate was met in July; the change was approved on that data. The fenced-share gate cannot move: only 14 chunks in the whole index are trusted (7 curated per vault), so every meeting hit is fenced at every factor. The external-root share (chunks from external roots) is the number to watch instead; it rose from 10 of 60 slots to 12 of 60 slots.

### Blind relevance judge

An independent judge scored the top 3 of each arm per query, labels shuffled, without seeing the factor. 9 of 10 queries were identical across the three arms. One query (retro feedback) scored 2 useful hits of 3 at factor 1.0 and 1 useful hit of 3 at factors 0.7 and 0.5: at 0.7 a summary section of the same retro file took rank 1 from a transcript fragment; at 0.5 two transcript fragments were replaced by a timeline table row and a registry row. The judge described the summary hit as coming from a different meeting; it is the same file. Factor 0.5 is rejected on this query. Factor 0.7 is the working value; whether the one-point loss on that query blocks the change is the owner's call.

### Curated-shaped set

Result: of the 5 queries, one gained the curated `USER.md` at rank 1 after the change (a work-vault query about reply style), one already had it at rank 1, and 3 showed no curated file in the top 6 before or after.

Why the global queries (two of the five) do not move: the curated chunk is not in the candidate pool at all. The lexical and vector channels each keep 50 candidates, and the global vault holds 27,069 raw session chunks against 7 curated chunks, so the pool fills with sessions before USER.md or MEMORY.md enters. The global USER.md is also written in Portuguese, so an English query reaches it only through the vector channel. No fusion factor can lift a chunk that is not a candidate. This is a candidate-pool problem and is recorded as a follow-up.

### Follow-ups found on the way (not in this change)

1. Candidate pool: give the curated layer its own channel or a reserved share of the pool, so a curated chunk is always a candidate. Without it, the global vault never shows USER.md or MEMORY.md for a natural-language query.
2. `PROJECT.md` is indexed as reservoir, not curated: `classifyFile` in `src/index/indexer.ts` only recognises `user` and `memory` at the vault root. PROJECT.md is therefore untrusted, fenced, and tier processed, although `memory vault add` seeds it as a curated file.
3. Retrieval push cuts the fence: `src/daemon/capture/push.ts` slices the snippet to `MAX_SNIPPET` characters after `wrapUntrusted`, so the closing `</untrusted-memory nonce=...>` tag and the end notice are lost in the SessionStart snapshot. Fix: slice the plain body first, then wrap.
