#!/usr/bin/env node
// In-process sweep of SEARCH_DEFAULTS.TIER_RAW_FACTOR over the LIVE, READ-ONLY
// index. Every factor arm runs both query sets against the SAME corpus in the
// same process, so before/after arms cannot drift apart the way two separate
// `memory search` CLI invocations (each against whatever the daemon's live
// corpus happens to be at that second) would.
//
// Usage: node scripts/tier-measure.mjs --factors 1.0,0.7,0.5 --out <file.json> [--k 6]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';

import { loadConfig } from '../dist/core/config.js';
import { readableVaults } from '../dist/core/vault-scope.js';
import { openIndexDb } from '../dist/index/db.js';
import { buildSearchContext } from '../dist/index/context.js';
import { memorySearch, SEARCH_DEFAULTS } from '../dist/index/search/search.js';
import { BruteForceVectorIndex } from '../dist/index/search/vector.js';
import { EmbedClient } from '../dist/embed/client.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');

// Example queries only: replace them with queries from your own vault.
/** MEETING set (meeting-shaped queries on a vault named `work`). */
const MEETING_QUERIES = [
  { query: 'what did we agree about the backup schedule', vault: 'work' },
  { query: 'feedback from the last retrospective', vault: 'work' },
  { query: 'rollout plan for the new release', vault: 'work' },
  { query: 'open issues with the data pipeline', vault: 'work' },
  { query: 'open questions from the planning meeting', vault: 'work' },
];

/** CURATED set (curated-shaped queries, each on its own vault). */
const CURATED_QUERIES = [
  { query: 'how does the owner want replies in chat', vault: 'global' },
  { query: 'how does the owner want replies in chat', vault: 'work' },
  { query: 'what is the owner role', vault: 'work' },
  { query: 'which repos belong to the main project', vault: 'work' },
  { query: 'rules for writing durable facts to memory', vault: 'global' },
];

/** Same fenced rule the fusion/envelope code uses: the opening tag in the snippet. */
function isFenced(snippet) {
  return snippet.includes('<untrusted-memory');
}

/**
 * Splits `path_hint` (`<vault>:<path>` or `<vault>::<name>:<path>` for an
 * external root) at the first LONE colon, i.e. the one that is not part of a
 * `::` pair. Vault names never contain a lone colon, only the `::` separator
 * of a synthetic external-root identity, so this is unambiguous.
 */
function splitPathHint(hint) {
  const PLACEHOLDER = '\u0000';
  const masked = hint.split('::').join(PLACEHOLDER);
  const sep = masked.indexOf(':');
  const restore = (s) => s.split(PLACEHOLDER).join('::');
  if (sep === -1) return { source: restore(masked), path: '' };
  return { source: restore(masked.slice(0, sep)), path: restore(masked.slice(sep + 1)) };
}

/**
 * Snippet with the envelope's frame lines and `<untrusted-memory ...>` tags
 * stripped, whitespace collapsed, capped at 240 chars: plain text for a later
 * blind relevance judge, independent of the trust/fence machinery.
 */
function plainSnippet(snippet) {
  const stripped = snippet
    .replace(/\[third-party content;[^\]]*\]/gi, ' ')
    .replace(/\[end of third-party content\]/gi, ' ')
    .replace(/<\/?untrusted-memory[^>]*>/gi, ' ');
  return stripped.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** One search hit reduced to the fields the sweep records and prints. */
function recordHit(hit) {
  const { source, path: hintPath } = splitPathHint(hit.path_hint);
  return {
    rank: hit.rank,
    tier: hit.tier,
    trust: hit.trust,
    fenced: isFenced(hit.snippet),
    source,
    external: source.includes('::'),
    path: hintPath,
    heading: hit.heading,
    rrf: hit.scores?.rrf ?? null,
    plain: plainSnippet(hit.snippet),
  };
}

/** Runs one query and reduces its response to {n, query, hits}. */
async function runQuery(ctx, q, n, k) {
  const res = await memorySearch(ctx, { query: q.query, k });
  return { n, query: q.query, hits: res.hits.map(recordHit) };
}

/**
 * MEETING-set metrics for one arm: slot composition by tier, how much of it is
 * fenced or from an external root, and which queries let a raw hit outrank a
 * processed hit from the SAME file (the exact failure the tier factor targets).
 */
function meetingMetrics(perQuery) {
  let total = 0, raw = 0, processed = 0, curated = 0, fenced = 0, external = 0;
  const flagged = [];
  for (const q of perQuery) {
    // Group this query's hits by file (source+path) to compare tiers within it.
    const byFile = new Map();
    for (const h of q.hits) {
      total++;
      if (h.tier === 'raw') raw++;
      else if (h.tier === 'processed') processed++;
      else if (h.tier === 'curated') curated++;
      if (h.fenced) fenced++;
      if (h.external) external++;
      const key = `${h.source}:${h.path}`;
      const entry = byFile.get(key) ?? { raw: [], processed: [] };
      if (h.tier === 'raw') entry.raw.push(h.rank);
      else if (h.tier === 'processed') entry.processed.push(h.rank);
      byFile.set(key, entry);
    }
    const hasRawOverProcessed = [...byFile.values()]
      .some((e) => e.raw.length > 0 && e.processed.length > 0 && Math.min(...e.raw) < Math.min(...e.processed));
    if (hasRawOverProcessed) flagged.push(q.n);
  }
  const pct = (n) => (total > 0 ? Number(((100 * n) / total).toFixed(1)) : 0);
  return {
    total_slots: total,
    raw_slots: raw, raw_pct: pct(raw),
    processed_slots: processed, processed_pct: pct(processed),
    curated_slots: curated, curated_pct: pct(curated),
    fenced_slots: fenced, fenced_pct: pct(fenced),
    external_slots: external, external_pct: pct(external),
    queries_raw_over_processed_same_file: flagged,
  };
}

/** CURATED-set per-query metrics: is a curated file in the top k, and at what rank. */
function curatedPerQuery(perQuery) {
  return perQuery.map((q) => {
    const hit = q.hits.find((h) => /(?:USER|MEMORY|PROJECT)\.md$/.test(h.path));
    return {
      n: q.n,
      query: q.query,
      curated_file_in_top_k: hit !== undefined,
      first_curated_rank: hit ? hit.rank : null,
    };
  });
}

/** Compact per-hit table: query no, rank, tier initial, fenced/external flags, source:path, heading. */
function printMeetingTable(perQuery) {
  for (const q of perQuery) {
    for (const h of q.hits) {
      const srcPath = `${h.source}:${h.path}`.slice(0, 55);
      const heading = (h.heading ?? '').slice(0, 40);
      console.log(
        `  Q${String(q.n).padStart(2)} rank ${String(h.rank).padStart(2)} ${h.tier[0]} `
        + `${h.fenced ? 'F' : '-'} ${h.external ? 'E' : '-'} ${srcPath.padEnd(55)} ${heading}`,
      );
    }
  }
}

function printMeetingMetrics(m) {
  console.log(`  total_slots=${m.total_slots} raw=${m.raw_slots} (${m.raw_pct}%) processed=${m.processed_slots} (${m.processed_pct}%) `
    + `curated=${m.curated_slots} (${m.curated_pct}%) fenced=${m.fenced_slots} (${m.fenced_pct}%) external=${m.external_slots} (${m.external_pct}%)`);
  console.log(`  queries_raw_over_processed_same_file: ${m.queries_raw_over_processed_same_file.join(', ') || 'none'}`);
}

function printCurated(perQuery) {
  for (const q of perQuery) {
    console.log(q.curated_file_in_top_k
      ? `  Q${q.n}: curated file at rank ${q.first_curated_rank} -- ${q.query}`
      : `  Q${q.n}: no curated file in top k -- ${q.query}`);
  }
}

/** --factors, --out, --k. Anything malformed or missing prints usage and exits 2. */
function parseArgs(argv) {
  let factorsRaw, outFile, k = 6;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--factors') factorsRaw = argv[++i];
    else if (argv[i] === '--out') outFile = argv[++i];
    else if (argv[i] === '--k') k = Number(argv[++i]);
    else usage();
  }
  if (!factorsRaw || !outFile) usage();
  const factors = factorsRaw.split(',').map((s) => Number(s.trim()));
  if (factors.length === 0 || factors.some((f) => !Number.isFinite(f))) usage();
  if (!Number.isFinite(k) || k <= 0) usage();
  return { factors, outFile, k };
}

function usage() {
  console.error('Usage: node scripts/tier-measure.mjs --factors 1.0,0.7,0.5 --out <file.json> [--k 6]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { factors, outFile, k } = parseArgs(process.argv.slice(2));

  const log = pino({ level: 'silent' });
  const config = loadConfig({ cwd: daemonDir });

  // Read-only: applyPragmas skips journal_mode in this mode, and this process
  // must never become a second writer against the daemon's live index.
  const db = openIndexDb({ readonly: true });
  const chunkCount = () => db.prepare(
    'SELECT count(*) AS n FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.is_deleted = 0',
  ).get().n;
  const chunkCountStart = chunkCount();

  // Vector channel exactly as daemon/main.ts wires it (lines ~218-233).
  const embedder = new EmbedClient({ model: config.embeddings.model, log });

  // Everything from here on can throw (memorySearch error, SQLITE_BUSY,
  // writeFileSync failure). The finally block is the only place that closes
  // the embedder and the db, so a throw never leaves the embedding worker
  // child alive and hanging, and the happy path never closes them twice.
  try {
    const vectorIndex = new BruteForceVectorIndex(db, embedder.model, embedder.dim);
    vectorIndex.reload();
    const vectorChannel = {
      warm: () => embedder.isWarm() && vectorIndex.size > 0,
      search: async (queryText, pool, minCosine, vaults, scope) => {
        const [vec] = await embedder.embedQueries([queryText]);
        return vec ? vectorIndex.search(vec, pool, minCosine, vaults, scope) : [];
      },
    };

    // A cold embedder makes memorySearch degrade to lexical-only silently, which
    // would compare the wrong thing across arms. Wait for warmup, capped at 60 s.
    const warmupPromise = embedder.warmup().catch(() => {});
    let degraded = false;
    const deadline = Date.now() + 60_000;
    while (!embedder.isWarm()) {
      if (Date.now() > deadline) { degraded = true; break; }
      await sleep(250);
    }
    void warmupPromise;

    // One context per distinct vault, built once and reused across every arm.
    const distinctVaults = [...new Set([...MEETING_QUERIES, ...CURATED_QUERIES].map((q) => q.vault))];
    const ctxByVault = new Map(distinctVaults.map((vault) => [
      vault,
      buildSearchContext(db, config, vectorChannel, readableVaults(config, vault, false)),
    ]));

    const arms = [];
    for (const factor of factors) {
      SEARCH_DEFAULTS.TIER_RAW_FACTOR = factor;
      console.log(`\n=== factor = ${factor} ===`);

      const meetingPerQuery = [];
      for (let i = 0; i < MEETING_QUERIES.length; i++) {
        const q = MEETING_QUERIES[i];
        meetingPerQuery.push(await runQuery(ctxByVault.get(q.vault), q, i + 1, k));
      }
      console.log('MEETING set:');
      printMeetingTable(meetingPerQuery);
      const meetingMetricsBlock = meetingMetrics(meetingPerQuery);
      printMeetingMetrics(meetingMetricsBlock);

      const curatedPerQueryRaw = [];
      for (let i = 0; i < CURATED_QUERIES.length; i++) {
        const q = CURATED_QUERIES[i];
        curatedPerQueryRaw.push(await runQuery(ctxByVault.get(q.vault), q, i + 1, k));
      }
      const curatedResult = curatedPerQuery(curatedPerQueryRaw);
      console.log('CURATED set:');
      printCurated(curatedResult);

      arms.push({
        factor,
        meeting: { per_query: meetingPerQuery, metrics: meetingMetricsBlock },
        curated: { per_query: curatedResult },
      });
    }

    const chunkCountEnd = chunkCount();
    if (chunkCountEnd !== chunkCountStart) {
      console.error(`warning: chunk_count drifted during the sweep (start=${chunkCountStart}, end=${chunkCountEnd})`);
    }

    const report = {
      k,
      measured_at: new Date().toISOString(),
      chunk_count_start: chunkCountStart,
      chunk_count_end: chunkCountEnd,
      degraded,
      arms,
    };
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${outFile}`);
  } finally {
    // Closes the worker child process so this short-lived process can exit.
    await embedder.close();
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
