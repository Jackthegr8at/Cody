import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * bin/cody-server.js loads its TypeScript modules through a bare
 * `createJiti(__filename)` — no tsconfig paths — so an `@/…` import anywhere in
 * that graph is MODULE_NOT_FOUND at startup: the whole server fails to boot.
 * Every other test loads modules with `tsconfigPaths: true`, which is why a
 * single alias in lib/model-presets once passed the full suite and still
 * crashed the server. The entry list is read from the server file itself, so a
 * new jiti() entry is covered without editing this test.
 */
const root = path.resolve(import.meta.dirname, "..");
const serverSource = readFileSync(path.join(root, "bin/cody-server.js"), "utf8");
const entries = [...serverSource.matchAll(/jiti\(\s*"(\.\.\/lib\/[^"]+)"\s*\)/g)]
  .map((match) => path.resolve(root, "bin", match[1]));

const SPECIFIER = /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g;

function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

test("the custom server's import graph uses no tsconfig path aliases", () => {
  assert.ok(entries.length > 0, "cody-server.js jiti entries were found");
  const seen = new Set();
  const queue = [...entries];
  const offenders = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      // `import type` is erased before jiti ever resolves it.
      if (/^\s*(?:import|export)\s+type\s/.test(match[0].trimStart())) continue;
      if (specifier.startsWith("@/")) offenders.push(`${path.relative(root, file)} -> ${specifier}`);
      else if (specifier.startsWith(".")) {
        const next = resolveRelative(file, specifier);
        if (next) queue.push(next);
      }
    }
  }
  assert.deepEqual(offenders, [], "use a relative import: the server's jiti has no path aliases");
});
