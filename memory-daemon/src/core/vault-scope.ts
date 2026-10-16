import type { MemoryConfig } from './config.js';

/**
 * Vault READ isolation: which vaults one caller may read from.
 *
 * Writes route to the caller's own vault (the `.memory.yml` marker picks it).
 * Reads used to be wider: every caller also read the shared `global` vault, so a
 * personal profile written in one context appeared in every other one. This
 * module holds the one rule that decides it, in a single place both the daemon
 * and the offline fallbacks import.
 *
 * THE RULE: a caller reads its OWN vault, and nothing else. Every vault is
 * self-contained: it holds its own USER.md, MEMORY.md and PROJECT.md. The shared
 * `global` vault is added ONLY when the caller's repo asked for it, with
 * `share_global: true` in its `.memory.yml`. Sharing is an explicit choice, never
 * the default, so a new project starts with empty memory on purpose.
 *
 * The readable set is always computed SERVER-SIDE from the scope the proxy
 * resolved, exactly like the `actor` field of the write pipeline. The MCP tool
 * schemas carry no vault field and no sharing field, so an agent cannot name
 * another vault, ask for "everything", or invite the shared vault in. Only the
 * human at the CLI may widen (`--vault all`), for the same reason the human CLI
 * is exempt from the injection scan: a person typing at their own terminal is
 * trusted, an agent is not.
 */

/** The shared personal vault. Readable only from a repo that invites it in. */
export const GLOBAL_VAULT = 'global';

/**
 * Separator of the synthetic index identity of an external root:
 * `<vault>::<name>`. A registered read-only folder (config `external_roots`)
 * indexes under this identity, so the whole indexing machinery treats it as
 * just another root while the files can never collide with real vault files.
 * `::` is outside the vault-name charset, so the identity is unambiguous and a
 * real vault can never be named like one.
 */
export const EXTERNAL_SEP = '::';

/** The index identity one external root's files carry in the files table. */
export function externalIndexId(vault: string, rootName: string): string {
  return `${vault}${EXTERNAL_SEP}${rootName}`;
}

/**
 * The human's widening sentinel (`memory search --vault all`). It is a reserved
 * vault name: `memory vault add` refuses it, so a real vault can never be named
 * `all` and accidentally turn every search into a cross-client search.
 */
export const ALL_VAULTS = 'all';

/**
 * What one caller may read: its own vault, and whether the shared vault joins it.
 *
 * `vault: null` is not "unknown, pick something sensible"; it means THIS CALLER
 * HAS NO READABLE VAULT. It is what a `.memory.yml` we could not honour produces.
 * Both fields travel together because reading one without the other silently
 * widens or narrows the answer.
 */
export interface ReadScope {
  /** The caller's vault, or null when its repo marker could not be honoured. */
  vault: string | null;
  /** True when that repo opted in to the shared vault (`share_global: true`). */
  shareGlobal: boolean;
}

/**
 * The read scope of THIS process, from its own config. Four cases, and they are
 * deliberately not the same:
 *
 *  - NO `.memory.yml` marker: the repo has no vault of its own, so the config
 *    default is the honest answer, and no sharing. In a single-vault setup that
 *    default IS `global`, so such a person sees no change at all.
 *  - A marker naming a configured vault, with no `share_global`: that vault
 *    alone.
 *  - The same marker plus `share_global: true`: that vault and `global`.
 *  - A marker we could NOT honour (unknown vault name, or broken YAML):
 *    `markerBroken`. We do not know whose repo this is, so there is NOTHING to
 *    read. Falling back to `global` made no sense any more: the shared vault now
 *    needs an invitation, and a marker that does not parse cannot express one.
 *
 * This is a READ rule only. Where writes go is decided separately, by
 * `resolveMemoryFile` / `resolveTargetVault`, and this function never changes it.
 */
export function ambientReadScope(config: MemoryConfig): ReadScope {
  if (config.markerBroken) return { vault: null, shareGlobal: false };
  return { vault: config.defaultVault, shareGlobal: config.shareGlobal === true };
}

/**
 * The single vault this process reads and writes in, or undefined when its repo
 * marker could not be honoured. Callers must handle the undefined: it is the
 * "we do not know whose repo this is" state, and guessing a vault there is the
 * confidentiality break this whole module exists to prevent.
 */
export function ambientReadVault(config: MemoryConfig): string | undefined {
  return config.markerBroken ? undefined : config.defaultVault;
}

/**
 * The vaults a caller may read: `undefined` for "every vault" (the human escape
 * hatch only), or an explicit list. An EMPTY list is a real answer, not a bug: it
 * means this caller may read nothing, so every channel must return no hits.
 *
 * `vault` distinguishes three inputs on purpose:
 *  - a name: that caller's vault, decided by the caller itself;
 *  - `null`: the caller resolved its scope and found none (broken marker);
 *  - omitted: use this process's own ambient scope.
 *
 * `shareGlobal` is only read when a name is given, and it defaults to FALSE.
 * That matters in the daemon: the daemon is one shared process, so its own
 * config describes the repo that started it. Inheriting the flag from there
 * would let one repo's invitation apply to every other caller.
 */
export function readableVaults(
  config: MemoryConfig,
  vault?: string | null | undefined,
  shareGlobal?: boolean | undefined,
): readonly string[] | undefined {
  // Only a trusted human caller sends this sentinel; the MCP proxy overwrites
  // the field with the resolved vault name, so an agent can never reach here.
  if (vault === ALL_VAULTS) return undefined;
  const scope: ReadScope = vault === undefined
    ? ambientReadScope(config)
    : { vault, shareGlobal: shareGlobal === true };
  // Nothing readable: a marker we could not honour. An empty set, never a
  // fallback, so no query path can quietly widen it back to a real vault.
  if (scope.vault === null) return [];
  // An unknown vault name is NOT expanded to something else: it simply matches
  // no file, so a bad name returns nothing instead of another client's notes.
  if (!scope.shareGlobal || scope.vault === GLOBAL_VAULT) {
    return withExternalRoots(config, [scope.vault]);
  }
  return withExternalRoots(config, [scope.vault, GLOBAL_VAULT]);
}

/**
 * Adds the synthetic identities of the external roots OWNED by a readable
 * vault. Reading a vault includes its registered read-only folders; it never
 * works the other way around — an external root cannot pull its owner (or any
 * other vault) into scope, because the expansion only ever appends.
 */
function withExternalRoots(config: MemoryConfig, vaults: readonly string[]): readonly string[] {
  const entries = Object.entries(config.externalRoots ?? {});
  if (entries.length === 0) return vaults;
  const out = [...vaults];
  for (const [name, root] of entries) {
    if (vaults.includes(root.vault)) out.push(externalIndexId(root.vault, name));
  }
  return out;
}

/** True when `vault` is inside the readable set (`undefined` = no restriction). */
export function isReadableVault(vaults: readonly string[] | undefined, vault: string): boolean {
  return vaults === undefined || vaults.includes(vault);
}

/**
 * One plain-English sentence naming the vaults a search in this scope reads.
 * Shared by `memory vault list` and the next-steps text of `memory vault add`,
 * so a person is told the rule the same way wherever they meet it.
 */
export function describeReadScope(scope: ReadScope): string {
  if (scope.vault === null) {
    return 'A search here reads nothing: this folder has no vault it can use.';
  }
  if (scope.vault === GLOBAL_VAULT) {
    return `A search here reads '${GLOBAL_VAULT}', and nothing else.`;
  }
  return scope.shareGlobal
    ? `A search here reads '${scope.vault}' and the shared '${GLOBAL_VAULT}' vault, because this folder's `
      + '.memory.yml says share_global: true.'
    : `A search here reads '${scope.vault}', and nothing else. The shared '${GLOBAL_VAULT}' vault is NOT `
      + "included: add 'share_global: true' to this folder's .memory.yml if you want it.";
}

/**
 * The parts of an unusable `.memory.yml` that an error hint or a scope notice
 * needs. `MemoryConfig` already has these fields, so a config can be passed
 * straight in; the daemon builds one from the cwd a client sent instead, because
 * its OWN config describes the repo that started it, not the caller's.
 */
export interface MarkerProblem {
  /** Absolute path of the marker that could not be honoured. */
  markerFile?: string | undefined;
  /** The vault name it asked for; absent when the file did not parse. */
  markerVault?: string | undefined;
}

/**
 * One plain-English sentence naming the file to fix and the command that fixes
 * it. Shared by the write refusal (VAULT_UNRESOLVED) and the search notice, so
 * a person or an agent reads the SAME explanation wherever the broken marker
 * bites. It names only the vault the caller's own repo asked for; the names of
 * the other configured vaults stay out, because the whole point of failing
 * closed is that this caller must not learn about them.
 */
export function markerFixHint(marker: MarkerProblem): string {
  const file = marker.markerFile ?? '.memory.yml';
  return marker.markerVault
    ? `The repo marker ${file} asks for the vault '${marker.markerVault}', which is not configured. `
      + `Add it with: memory vault add ${marker.markerVault} <path>, or correct the vault name in ${file}.`
    : `The repo marker ${file} could not be read. Make it valid YAML with a 'vault: <name>' line, `
      + 'or delete the file.';
}

/**
 * The advisory line a search response carries when this process could not
 * honour the repo marker, or undefined when there is nothing to say.
 *
 * Without it a broken marker is invisible to an agent: it gets zero results and
 * no reason, which reads as "my memory disappeared". Same shape and placement as
 * `safety_notice`: a top-level field on the search response, out of band from any
 * single snippet.
 */
export function scopeNotice(config: MemoryConfig): string | undefined {
  if (!config.markerBroken) return undefined;
  return 'This folder\'s memory marker could not be used, so no vault could be searched here and this '
    + 'search found nothing. Notes kept in a project vault, and notes in the shared '
    + `'${GLOBAL_VAULT}' vault, cannot appear in these results until the marker is fixed. `
    + markerFixHint(config);
}

/**
 * Adds `scope_notice` to a search response when the marker is broken, and
 * returns the response untouched otherwise. Kept generic so this module stays
 * free of any dependency on the search types.
 */
export function withScopeNotice<T extends object>(config: MemoryConfig, response: T): T & { scope_notice?: string } {
  const notice = scopeNotice(config);
  return notice ? { ...response, scope_notice: notice } : response;
}

/**
 * A vault name safe to put in a config file, a `.memory.yml` marker and a SQL
 * bind parameter: letters, digits, '-' and '_', starting with a letter or digit.
 * Keeps names typeable and keeps `path_hint` (`<vault>:<path>`) unambiguous.
 */
const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** Why a vault name was refused, or undefined when the name is fine. */
export function vaultNameProblem(name: string): string | undefined {
  if (!VAULT_NAME_RE.test(name)) {
    return 'A vault name may use only letters, digits, "-" and "_", must start with a letter or digit, and may be at most 32 characters long.';
  }
  if (name.toLowerCase() === ALL_VAULTS) {
    return `"${ALL_VAULTS}" is a reserved word: it means "every vault" in "memory search --vault all". Pick another name.`;
  }
  return undefined;
}
