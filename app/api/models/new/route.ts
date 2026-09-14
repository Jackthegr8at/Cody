import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@/lib/omp/paths";
import { getHarness, type HarnessAdapter } from "@/lib/harness";
import { modelKey } from "@/lib/model-allow-list";
import { type CatalogModel, compareModelEntries, FULL_CATALOG_CACHE_KEY, loadFullCatalog } from "@/lib/model-catalog-full";
import { diffNewModels, readSeenLedger, type SeenLedger } from "@/lib/model-catalog-seen";
import { loadCatalogWithCache, peekCatalogCache } from "@/lib/models-cache";
import { type OmpModel, runUtilityCommand } from "@/lib/omp/rpc-utility";
import { utilityRpcLaunchFor } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

/**
 * Models the ACTIVE engine's catalog has that the user has never been shown
 * (the "seen" ledger, lib/model-catalog-seen.ts).
 *
 * Under omp the comparison runs against the UNRESTRICTED catalog: a model
 * hidden by an exact-id `enabledModels` allowlist still counts as new, which
 * is the whole point — the allowlist is exactly what hides a model released
 * after the user curated. Another rpc-dialect engine (pi) has no curation
 * layer Cody knows about, so its effective list IS its catalog. An ACP
 * engine has no sessionless catalog at all (`catalogSource: "session"`, see
 * /api/models), so there is nothing to diff and no child is spawned.
 *
 * Fails soft exactly like /api/models: a loader failure (engine not
 * installed, RPC error) is a 200 with an empty list and `modelError`, never a
 * 500 — this feeds a status line, and a status line must not break the
 * panel it sits in.
 *
 * `?cached=1` answers from the catalog cache ONLY and never starts an engine
 * child: the settings rail, the composer footer and the post-install toast
 * all paint from it, and a status line that cold-starts an isolated omp
 * process on every open (measured at 20 s on a real install) is not a
 * status line. A cold cache is reported as `pending: true` with an empty
 * list; the hub's own open and its Refresh button run the full read.
 */

interface NewModelsResponse {
  newModels: CatalogModel[];
  total: number;
  seenAt: string | null;
  firstRun: boolean;
  catalogSource: "global" | "session";
  modelError?: string;
  /** `?cached=1` only: the catalog cache was cold AND nothing was ever
   *  remembered for this engine, so there is no count to show yet. */
  pending?: true;
  /** `?cached=1` only: the catalog cache was cold, so `total` is the last
   *  count this instance showed (persisted) and `newModels` was not compared;
   *  a background load is already warming the cache for the next read. */
  stale?: true;
}

/** The last catalog count per engine, persisted so the Settings rail can say
 * "566 models" the instant it opens instead of blanking until the utility
 * child has answered (a minute after every server start, and again every
 * hour when the full-catalog cache expires). */
const SUMMARY_FILE = "cody-model-catalog-summary.json";
type SummaryFile = Record<string, { total: number; at: string }>;
function readSummary(): SummaryFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(getAgentDir(), SUMMARY_FILE), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SummaryFile : {};
  } catch {
    return {};
  }
}
function writeSummary(engineId: string, total: number): void {
  const file = path.join(getAgentDir(), SUMMARY_FILE);
  const next = { ...readSummary(), [engineId]: { total, at: new Date().toISOString() } };
  try {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, file);
  } catch {
    // A summary that fails to persist costs one blank rail line, never a request.
  }
}

/** Warm the catalog cache without making the caller wait. `loadCatalogWithCache`
 * dedupes in-flight loads, so repeated rail polls never stack utility children. */
function warmCatalog(harness: HarnessAdapter): void {
  void (harness.id === "omp" ? loadFullCatalog() : loadEffectiveCatalog(harness)).catch(() => {});
}

const EFFECTIVE_CATALOG_KEY = (engineId: string) => `catalog:${engineId}`;

/** The effective catalog of a non-omp rpc-dialect engine, cached beside the
 * `/api/models` entry so repeated polls reuse one `get_available_models`. */
function loadEffectiveCatalog(harness: HarnessAdapter): Promise<CatalogModel[]> {
  return loadCatalogWithCache<CatalogModel[]>(EFFECTIVE_CATALOG_KEY(harness.id), async () => {
    const launch = utilityRpcLaunchFor(harness);
    const { models } = await runUtilityCommand<{ models: OmpModel[] }>(
      { type: "get_available_models" },
      120_000,
      launch,
    );
    return models
      .map((model) => ({ id: model.id, name: model.name || model.id, provider: model.provider }))
      .sort(compareModelEntries);
  });
}

function diffResponse(harnessId: string, catalog: CatalogModel[], ledger: SeenLedger): NewModelsResponse {
  const { newKeys, firstRun } = diffNewModels(catalog.map(modelKey), ledger);
  const fresh = new Set(newKeys);
  writeSummary(harnessId, catalog.length);
  return {
    newModels: catalog
      .filter((model) => fresh.has(modelKey(model)))
      .map(({ provider, id, name }) => ({ provider, id, name })),
    total: catalog.length,
    seenAt: ledger.seenAt,
    firstRun,
    catalogSource: "global",
  };
}

export async function GET(request: Request) {
  const harness = getHarness();
  if (!harness.rpcUi) {
    const sessionScoped: NewModelsResponse = { newModels: [], total: 0, seenAt: null, firstRun: false, catalogSource: "session" };
    return Response.json(sessionScoped);
  }
  const ledger = readSeenLedger(harness.id);
  // Older callers (the route tests) invoke GET() bare; a missing request is
  // the full read.
  const cachedOnly = typeof request?.url === "string" && new URL(request.url).searchParams.get("cached") === "1";
  if (cachedOnly) {
    const cached = peekCatalogCache<CatalogModel[]>(harness.id === "omp" ? FULL_CATALOG_CACHE_KEY : EFFECTIVE_CATALOG_KEY(harness.id));
    if (!cached) {
      warmCatalog(harness);
      const remembered = readSummary()[harness.id];
      if (!remembered) {
        const pending: NewModelsResponse = { newModels: [], total: 0, seenAt: ledger.seenAt, firstRun: ledger.seenAt === null, catalogSource: "global", pending: true };
        return Response.json(pending);
      }
      const stale: NewModelsResponse = { newModels: [], total: remembered.total, seenAt: ledger.seenAt, firstRun: ledger.seenAt === null, catalogSource: "global", stale: true };
      return Response.json(stale);
    }
    return Response.json(diffResponse(harness.id, cached, ledger));
  }
  try {
    const catalog = harness.id === "omp" ? await loadFullCatalog() : await loadEffectiveCatalog(harness);
    return Response.json(diffResponse(harness.id, catalog, ledger));
  } catch (error) {
    const failed: NewModelsResponse = {
      newModels: [],
      total: 0,
      seenAt: ledger.seenAt,
      firstRun: ledger.seenAt === null,
      catalogSource: "global",
      modelError: error instanceof Error ? error.message : String(error),
    };
    return Response.json(failed);
  }
}
