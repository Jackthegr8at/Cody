import { flattenModelsDevCatalog, type ModelCatalogEntry } from "./model-catalog";

/**
 * The one models.dev reader. The catalog picker (Add model from catalog) and
 * the missing-price fill (lib/model-price-fill.ts) both read through it, so
 * one hourly fetch serves both and they can never disagree about a price.
 */

export const MODELS_DEV_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

interface CatalogCache {
  entries: ModelCatalogEntry[];
  expiresAt: number;
  inFlight?: Promise<ModelCatalogEntry[]>;
}

declare global {
  var __codyModelsDevCatalogCache: CatalogCache | undefined;
}

async function fetchCatalog(): Promise<ModelCatalogEntry[]> {
  const response = await fetch(MODELS_DEV_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  const entries = flattenModelsDevCatalog(await response.json());
  if (entries.length === 0) throw new Error("models.dev returned an empty catalog");
  return entries;
}

/** The flattened models.dev catalog: cached for an hour, one fetch in flight at
 *  a time, and the last good copy served when a refresh fails. Throws only
 *  when no copy has ever been fetched. */
export async function loadModelsDevCatalog(): Promise<ModelCatalogEntry[]> {
  let cache = globalThis.__codyModelsDevCatalogCache;
  if (!cache) {
    cache = globalThis.__codyModelsDevCatalogCache = { entries: [], expiresAt: 0 };
  }
  if (cache.entries.length > 0 && cache.expiresAt > Date.now()) return cache.entries;
  if (!cache.inFlight) {
    const target = cache;
    target.inFlight = fetchCatalog().then((entries) => {
      target.entries = entries;
      target.expiresAt = Date.now() + CATALOG_TTL_MS;
      return entries;
    }).finally(() => {
      target.inFlight = undefined;
    });
  }

  try {
    return await cache.inFlight!;
  } catch (error) {
    if (cache.entries.length > 0) return cache.entries;
    throw error;
  }
}
