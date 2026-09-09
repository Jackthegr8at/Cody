import { isRecord } from "./type-guards";

/**
 * User-level MCP servers are editable from the browser, and their `headers`
 * and `env` maps are exactly where bearer tokens and API keys live. The rule
 * (`app/api/mcp/route.ts`) is that those values never leave the server, so the
 * edit form is fed a MASKED copy: every value under `headers`/`env` is
 * replaced by `MCP_SECRET_SENTINEL`, and a save merges each sentinel back to
 * the value currently on disk for that same server and key.
 *
 * A sentinel with nothing behind it is an error, never a silent write: saving
 * the placeholder itself would blank a credential the form never showed.
 *
 * Pure and dependency-free on purpose — the client component needs the
 * sentinel too, and `lib/omp/*` may not be imported from `components/`.
 */

export const MCP_SECRET_SENTINEL = "__cody_secret__";

/** The server fields that carry credentials. */
const SECRET_SECTIONS = ["headers", "env"] as const;

/** A copy safe to serialize to the browser: same shape, no secret values. */
export function maskMcpSecrets(server: Record<string, unknown>): Record<string, unknown> {
  let masked: Record<string, unknown> | null = null;
  for (const section of SECRET_SECTIONS) {
    const values = server[section];
    if (!isRecord(values)) continue;
    masked ??= { ...server };
    masked[section] = Object.fromEntries(Object.keys(values).map((key) => [key, MCP_SECRET_SENTINEL]));
  }
  return masked ?? server;
}

/** Resolve every sentinel in `server` against `previous` (the on-disk entry).
 * Throws when a sentinel has no stored value — the caller must reject the
 * write rather than persist the placeholder. */
export function mergeMcpSecrets(
  server: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> {
  let merged: Record<string, unknown> | null = null;
  for (const section of SECRET_SECTIONS) {
    const values = server[section];
    if (!isRecord(values)) continue;
    const previousSection = previous?.[section];
    const stored: Record<string, unknown> = isRecord(previousSection) ? previousSection : {};
    let resolved: Record<string, unknown> | null = null;
    for (const [key, value] of Object.entries(values)) {
      if (value !== MCP_SECRET_SENTINEL) continue;
      const kept = stored[key];
      if (typeof kept !== "string") {
        throw new Error(`No saved value for ${section}.${key} on "${name}" — enter the real value instead of the masked placeholder`);
      }
      resolved ??= { ...values };
      resolved[key] = kept;
    }
    if (!resolved) continue;
    merged ??= { ...server };
    merged[section] = resolved;
  }
  return merged ?? server;
}
