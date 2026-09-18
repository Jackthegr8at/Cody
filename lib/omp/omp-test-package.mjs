import fs from "node:fs";
import path from "node:path";

/**
 * The omp package the schema-pipeline tests read.
 *
 * These tests exercise the one part of Cody that depends on omp's own SOURCE
 * layout (the settings schema, the model-role vocabulary, the recommended
 * cards). They used to look at exactly one path — `/tmp/ompkg/package/bin/omp`,
 * an extraction nothing in this repo ever creates — so every one of them
 * SKIPPED, locally and in CI, and 18.2.5 moving `MODEL_ROLE_IDS` into a sibling
 * package went undetected until it was read by hand.
 *
 * So the fixture is now whatever omp is actually available: an explicit
 * `CODY_OMP_BIN`, the extracted tarball if someone made one, or the engine
 * installed on this machine. A machine with no omp at all still skips — that is
 * a genuine absence, not a silent one.
 */
export function ompTestPackageBin() {
  const candidates = [
    process.env.CODY_OMP_BIN,
    "/tmp/ompkg/package/bin/omp",
    ...installedCandidates(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Next candidate.
    }
  }
  return null;
}

/** Why the tests are skipping, in the shape node:test wants. */
export function ompTestPackageSkip() {
  return ompTestPackageBin() === null && "no omp package available";
}

function installedCandidates() {
  const home = process.env.HOME ?? "";
  const dataDirs = [
    process.env.CODY_TOOLS_DIR,
    process.env.PI_CODING_AGENT_DIR ? path.join(process.env.PI_CODING_AGENT_DIR, "tools") : null,
    home ? path.join(home, ".omp", "agent", "tools") : null,
  ].filter(Boolean);
  const fromPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return [
    ...dataDirs.map((dir) => path.join(dir, "bin", "omp")),
    ...fromPath.map((dir) => path.join(dir, "omp")),
  ];
}
