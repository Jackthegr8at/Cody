import { readFileSync, statSync } from "fs";
import { join } from "path";
import { isRecord } from "../type-guards";
import { findOmpPackageRoot, resolveSourceSpecifier } from "./package-source";

/**
 * Which models the INSTALLED omp ships a catalog entry for.
 *
 * `@oh-my-pi/pi-catalog`'s `models.json` is omp's own curated database
 * (pricing, context windows…), keyed `provider -> modelId`. A model in it has
 * a price omp chose, and that includes a deliberate zero (a prepaid plan, a
 * free tier). A model missing from it reached the registry through runtime
 * discovery and is priced at zero only because omp has no data yet — the
 * gap `lib/model-price-fill.ts` fills. Only membership is kept: the file is
 * ~11 MB and the prices themselves are omp's to apply.
 */

let cached: { path: string; mtimeMs: number; keys: ReadonlySet<string> } | null = null;

export function bundledModelKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

/** The package's `exports` map names only an `import` condition for
 *  `./models.json`, which `require.resolve` refuses; resolve it the way the
 *  settings reader resolves omp's other source files. */
function resolveCatalogPath(packageRoot: string): string | null {
  return resolveSourceSpecifier(join(packageRoot, "package.json"), "@oh-my-pi/pi-catalog/models.json");
}
/** `provider\0modelId` for every model omp's bundled catalog lists, or null
 *  when the catalog cannot be read — which callers must treat as "cannot tell
 *  omp's deliberate prices from missing ones", never as an empty catalog. */
export function readBundledModelKeys(packageRoot: string | null = findOmpPackageRoot()): ReadonlySet<string> | null {
  if (!packageRoot) return null;
  const path = resolveCatalogPath(packageRoot);
  if (!path) return null;
  try {
    const { mtimeMs } = statSync(path);
    if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.keys;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return null;
    const keys = new Set<string>();
    for (const [provider, models] of Object.entries(parsed)) {
      if (!isRecord(models)) continue;
      for (const modelId of Object.keys(models)) keys.add(bundledModelKey(provider, modelId));
    }
    if (keys.size === 0) return null;
    cached = { path, mtimeMs, keys };
    return keys;
  } catch {
    return null;
  }
}
