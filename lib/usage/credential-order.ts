import type { OmpCredentialRow } from "../harness/omp-credentials";
import type { UsageAccount, UsageSnapshot } from "./types";

/**
 * Ordering accounts the way the user was told they are ordered.
 *
 * Two Cody surfaces name the same account: Settings numbers a provider's
 * accounts by omp's credential row id (creation order — stable, and unmoved
 * by an account being disabled or hitting a limit), while the composer's
 * quota popup names them "Primary"/"Secondary" from the usage snapshot. But
 * `omp usage --json` lists reporting accounts first and appends disabled
 * tombstones after them, so the moment a primary account's token expired the
 * two surfaces disagreed outright: Settings called it Primary, the composer
 * called it Secondary and promoted the sibling.
 *
 * So the credential store is authoritative for ORDER on both surfaces. Only
 * disabled accounts carry their row id in the usage payload; the active ones
 * are matched here, by engine account id first and email second (an account
 * id never collides, an email can be reused across providers), which is the
 * same join `lib/omp/provider-login.ts` makes for state.
 *
 * Failure is not an error: an account that cannot be matched keeps
 * `credentialId: null` and sorts after every identified one, in the order the
 * engine reported it. That is exactly the pre-enrichment behaviour, so a
 * missing or unreadable credential store degrades to what shipped before
 * rather than reshuffling anything.
 */

function matchKeys(row: OmpCredentialRow): string[] {
  const keys: string[] = [];
  if (row.identity) keys.push(row.identity.trim().toLowerCase());
  return keys;
}

function accountKeys(account: UsageAccount): string[] {
  const keys: string[] = [];
  if (account.identity) keys.push(account.identity.trim().toLowerCase());
  if (account.id) keys.push(account.id.trim().toLowerCase());
  return keys;
}

/** Attach each account's credential row id, then order every provider's
 * accounts by it. Pure: takes the rows, returns a new snapshot. */
export function applyCredentialOrder(
  snapshot: UsageSnapshot,
  credentials: readonly OmpCredentialRow[],
): UsageSnapshot {
  if (!snapshot.available || snapshot.accounts.length === 0 || credentials.length === 0) return snapshot;

  // provider -> matchable key -> row id. Lowest row id wins a contested key so
  // the mapping is deterministic regardless of store iteration order.
  const byProvider = new Map<string, Map<string, number>>();
  for (const row of credentials) {
    let keys = byProvider.get(row.provider);
    if (!keys) {
      keys = new Map<string, number>();
      byProvider.set(row.provider, keys);
    }
    for (const key of matchKeys(row)) {
      const existing = keys.get(key);
      if (existing === undefined || row.id < existing) keys.set(key, row.id);
    }
  }

  const claimed = new Map<string, Set<number>>();
  const resolve = (account: UsageAccount): number | null => {
    if (account.credentialId !== null) return account.credentialId;
    const keys = byProvider.get(account.provider);
    if (!keys) return null;
    let taken = claimed.get(account.provider);
    if (!taken) {
      taken = new Set<number>();
      claimed.set(account.provider, taken);
    }
    for (const key of accountKeys(account)) {
      const id = keys.get(key);
      // One row backs one account: a second account matching the same row
      // (two reports for one credential) stays unidentified rather than
      // stealing a position already given away.
      if (id !== undefined && !taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
    return null;
  };

  const identified = snapshot.accounts.map((account) => ({ account, credentialId: resolve(account) }));
  // Claim the ids the disabled tombstones already carried, so an active
  // account cannot be matched onto a row a tombstone owns.
  const accounts = identified
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => {
      if (a.credentialId === b.credentialId) return a.index - b.index;
      if (a.credentialId === null) return 1;
      if (b.credentialId === null) return -1;
      return a.credentialId - b.credentialId;
    })
    .map(({ account, credentialId }) => (account.credentialId === credentialId ? account : { ...account, credentialId }));

  return { ...snapshot, accounts };
}
