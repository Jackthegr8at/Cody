import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createJiti } from "jiti";
import { ompTestPackageBin, ompTestPackageSkip } from "./omp-test-package.mjs";

const FAKE_BIN = ompTestPackageBin();
const skip = ompTestPackageSkip();

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * A rule naming a setting the installed engine does not declare is ambiguous:
 * either upstream renamed it away (the failure this test exists for) or the
 * rule targets a NEWER engine than the one installed here. The audited version
 * marker tells them apart, so the unmatched-rule check only judges an engine
 * at least as new as what this build was audited against.
 */
async function rulesAreJudgeable() {
  if (FAKE_BIN === null) return false;
  const { ompPackageVersion, findOmpPackageRoot } = await jiti.import("./package-source.ts");
  process.env.CODY_OMP_BIN = FAKE_BIN;
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  const root = findOmpPackageRoot() ?? path.resolve(path.dirname(FAKE_BIN), "..");
  const installed = ompPackageVersion(root);
  const { ompHarness } = await jiti.import("../harness/omp.ts");
  const audited = ompHarness.verifiedVersion;
  if (!installed || !audited) return false;
  const rank = (version) => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [rank(installed), rank(audited)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

async function loadSchema() {
  process.env.CODY_OMP_BIN = FAKE_BIN;
  const { getOmpSettingsSchema, clearOmpSettingsSchemaCache } = await jiti.import("./settings-schema.ts");
  (await jiti.import("./omp-cli.ts")).invalidateOmpCliCache();
  clearOmpSettingsSchemaCache();
  return getOmpSettingsSchema();
}

test("every terminal-only rule still matches the installed schema", { skip }, async (t) => {
  if (!(await rulesAreJudgeable())) {
    t.diagnostic("installed omp predates the audited version — rules may name settings it does not declare yet");
    return;
  }
  const schema = await loadSchema();
  const keys = new Set(schema.settings.map((setting) => setting.key));
  const { TERMINAL_ONLY_RULES } = await jiti.import("./settings-surface.ts");

  // A rule that matches nothing is a rule the harness renamed out from under
  // us — the badge would silently stop appearing for a setting that still does
  // nothing in the browser.
  for (const key of TERMINAL_ONLY_RULES.keys) {
    assert.ok(keys.has(key), `terminal-only key "${key}" is no longer in the schema`);
  }
  for (const prefix of TERMINAL_ONLY_RULES.prefixes) {
    assert.ok(
      [...keys].some((key) => key.startsWith(prefix)),
      `terminal-only prefix "${prefix}" no longer matches any setting`,
    );
  }
});

test("every Cody-behaviour note still names a setting the engine declares", { skip }, async () => {
  const schema = await loadSchema();
  const keys = new Set(schema.settings.map((setting) => setting.key));
  const { SETTING_NOTE_KEYS, settingNoteFor } = await jiti.import("./settings-surface.ts");

  // A note whose key was renamed upstream is worse than no note: the caveat
  // silently stops being shown for a setting that still behaves that way.
  for (const key of SETTING_NOTE_KEYS) {
    assert.ok(keys.has(key), `noted key "${key}" is no longer in the schema`);
  }
  assert.equal(settingNoteFor("prewalk.enabled"), undefined);
  // The note must reach the panel through the schema, not just the lookup.
  const noted = schema.settings.find((setting) => setting.key === "retry.usageAwareFallback");
  assert.match(noted?.codyNote ?? "", /Auto-fallback/);
});

test("classifies terminal chrome without catching settings the browser uses", { skip }, async () => {
  const { isTerminalOnlySetting } = await jiti.import("./settings-surface.ts");

  for (const key of ["theme.dark", "statusLine.preset", "tui.tight", "display.shimmer", "startup.showSplash", "symbolPreset"]) {
    assert.equal(isTerminalOnlySetting(key), true, `${key} should be terminal-only`);
  }
  // These drive the agent itself and reach Cody's UI, so they must stay unmarked.
  for (const key of ["prewalk.enabled", "task.eager", "compaction.enabled", "memory.backend", "tools.approvalMode", "defaultThinkingLevel"]) {
    assert.equal(isTerminalOnlySetting(key), false, `${key} must not be marked terminal-only`);
  }
  // Prefixes match on the dotted path, not a bare substring.
  assert.equal(isTerminalOnlySetting("mytui.thing"), false);
});
