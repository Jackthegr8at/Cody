import { existsSync, promises as fs } from "fs";
import { homedir } from "os";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { getHarness } from "@/lib/harness";
import { readPersistedBoolean, readPersistedStringList } from "@/lib/omp/settings-values";
import type { SkillInfo, SkillInstallScope } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";

/**
 * Where each active engine discovers skills. omp reads a full hierarchy of
 * compatibility roots and its own providers (see lib/omp/paths.ts); pi
 * (pi-mono coding-agent package-manager.js addAutoDiscoveredResources)
 * reads a narrower set: <cwd>/.pi/skills, .agents/skills walked up to the
 * git root, <agent dir>/skills and ~/.agents/skills — no .claude/.codex/
 * .github compat dirs and no managed-skills dir, so scanning those under pi
 * would list skills the engine never loads. Cody cannot import these SDKs,
 * so the scan rules are replicated per engine.
 */

export interface SkillDiagnostic {
  type: "error" | "warning" | "info";
  message: string;
  path?: string;
}

export interface SkillsWithDiagnostics {
  skills: SkillInfo[];
  diagnostics: SkillDiagnostic[];
}

interface SkillScanRoot {
  dir: string;
  /** Provider label surfaced as sourceInfo.source (".omp", ".claude", ...). */
  source: string;
  scope: "user" | "project";
  /** omp skips skills without a description for these providers. */
  requireDescription?: boolean;
}

export interface ParsedSkillFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Split YAML frontmatter from a markdown document. Returns an empty
 * frontmatter object when no `---` block is present or YAML is invalid. */
export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = parseYaml(match[1]) as unknown;
    const frontmatter =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return { frontmatter, body: content.slice(match[0].length) };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true";
}

/** Ancestor directories from cwd up to the git repo root (or $HOME / fs root),
 * closest first — matches omp's project-level walk-up discovery. */
function getAncestorDirs(cwd: string): string[] {
  const home = homedir();
  const dirs: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    dirs.push(current);
    if (existsSync(path.join(current, ".git"))) break;
    if (current === home) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/** pi's discovery (see module doc): project .pi/skills + .agents/skills
 * walk-up, then user <agent dir>/skills + ~/.agents/skills. */
function buildPiScanRoots(cwd: string): SkillScanRoot[] {
  const home = homedir();
  const agentDir = getHarness().getAgentDir();
  const projectAncestors = getAncestorDirs(cwd).filter((dir) => dir !== home);
  const roots: SkillScanRoot[] = [];

  // Project scope: .pi/skills at the cwd only (pi does not walk .pi up), and
  // .agents/skills from the cwd up to the git root.
  roots.push({ dir: path.join(cwd, ".pi", "skills"), source: ".pi", scope: "project" });
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".agents", "skills"), source: ".agents", scope: "project" });
  }

  // User scope: pi's own agent dir, then the ecosystem ~/.agents/skills —
  // also where Cody's global skill installs land, so installs stay loadable.
  roots.push({ dir: path.join(agentDir, "skills"), source: ".pi", scope: "user" });
  roots.push({ dir: path.join(home, ".agents", "skills"), source: ".agents", scope: "user" });

  return roots;
}


/**
 * Whether omp still reads another tool's USER-level skills directory.
 *
 * omp 18.1.5 made those an opt-in: `~/.claude/skills` and `~/.codex/skills` are
 * loaded only when their flag is set, or when the provider was opted in through
 * `enabledProviders`, or — for claude — when CLAUDE_CONFIG_DIR names the
 * directory outright (omp's `isSourceEnabled`). Project-level `.claude`/`.codex`
 * under the cwd are unaffected and always load. Listing a root omp no longer
 * reads would offer skills the session cannot invoke.
 *
 * Only omp's own settings can answer this, so the gate applies only while omp
 * is the engine: Claude Code reads `~/.claude/skills` whatever omp thinks, and
 * Codex `~/.codex/skills`.
 */
function foreignUserSkillsEnabled(provider: "claude" | "codex"): boolean {
  if (getHarness().id !== "omp") return true;
  // Absent means omp's own default, and both default to off since 18.1.5.
  if (readPersistedBoolean(provider === "claude" ? "skills.enableClaudeUser" : "skills.enableCodexUser") === true) return true;
  const enabled = readPersistedStringList("enabledProviders") ?? [];
  if (enabled.includes(provider) || enabled.includes("*") || enabled.includes("all")) return true;
  return provider === "claude" && Boolean(process.env.CLAUDE_CONFIG_DIR?.trim());
}

/** Scan roots in omp's provider priority order (highest first): .omp (100),
 * .claude (80), .agent/.agents + .codex + .github (70), managed skills (5).
 * pi gets its own narrower walk (above). */
function buildScanRoots(cwd: string): SkillScanRoot[] {
  if (getHarness().id === "pi") return buildPiScanRoots(cwd);
  const home = homedir();
  // The ACTIVE engine's dir, not omp's. Reading lib/omp/paths here meant
  // every engine scanned ~/.omp/agent for its skills — so a Claude Code or
  // Codex session offered omp's skills, which it cannot load. The pi branch
  // above already did this correctly; this one did not.
  const agentDir = getHarness().getAgentDir();
  const ancestors = getAncestorDirs(cwd);
  const projectAncestors = ancestors.filter((dir) => dir !== home);
  const roots: SkillScanRoot[] = [];

  // builtin (.omp): project walk-up first (closest first), then user dir.
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".omp", "skills"), source: ".omp", scope: "project", requireDescription: true });
  }
  roots.push({ dir: path.join(agentDir, "skills"), source: ".omp", scope: "user", requireDescription: true });

  // claude compat: user ~/.claude/skills + project .claude/skills walk-up.
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  if (foreignUserSkillsEnabled("claude")) {
    roots.push({ dir: path.join(claudeHome, "skills"), source: ".claude", scope: "user" });
  }
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".claude", "skills"), source: ".claude", scope: "project" });
  }

  // agent dirs compat (.agent/.agents): project walk-up + user home.
  for (const dir of projectAncestors) {
    roots.push({ dir: path.join(dir, ".agent", "skills"), source: ".agents", scope: "project" });
    roots.push({ dir: path.join(dir, ".agents", "skills"), source: ".agents", scope: "project" });
  }
  roots.push({ dir: path.join(home, ".agent", "skills"), source: ".agents", scope: "user" });
  roots.push({ dir: path.join(home, ".agents", "skills"), source: ".agents", scope: "user" });

  // codex compat: user ~/.codex/skills + project .codex/skills.
  if (foreignUserSkillsEnabled("codex")) {
    roots.push({ dir: path.join(home, ".codex", "skills"), source: ".codex", scope: "user" });
  }
  roots.push({ dir: path.join(cwd, ".codex", "skills"), source: ".codex", scope: "project" });

  // github compat: <repoRoot>/.github/skills.
  const repoRoot = ancestors[ancestors.length - 1];
  roots.push({ dir: path.join(repoRoot, ".github", "skills"), source: ".github", scope: "project", requireDescription: true });

  // managed auto-learn skills (lowest priority).
  roots.push({ dir: path.join(agentDir, "managed-skills"), source: "managed", scope: "user", requireDescription: true });

  return roots;
}

/** Directories the discovery walk reads, for callers that must authorize a
 * skill path (single source of truth with buildScanRoots — a narrower list
 * would reject skills the app itself discovered and installed). Without a cwd
 * only the cwd-independent user-scope roots are returned. */
export function getSkillScanRootDirs(cwd?: string): string[] {
  return buildScanRoots(cwd ?? homedir()).map((root) => root.dir);
}

const DISABLE_INVOCATION_KEYS = ["disable-model-invocation", "disableModelInvocation", "hide"] as const;
/** Agent Skills standard spelling — used when no variant is present yet. */
const CANONICAL_DISABLE_KEY = DISABLE_INVOCATION_KEYS[0];

/** True when any of the three spellings omp honors is set
 * (frontmatter.hide === true || frontmatter.disableModelInvocation === true,
 * with `disable-model-invocation` normalized into the latter). */
export function readDisableModelInvocation(frontmatter: Record<string, unknown>): boolean {
  return DISABLE_INVOCATION_KEYS.some((key) => isTruthyFlag(frontmatter[key]));
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const DISABLE_KEY_LINE_RE = new RegExp(`^(?:${DISABLE_INVOCATION_KEYS.join("|")})[ \\t]*:.*$`);

/** Set/clear the disable-model-invocation flag in a SKILL.md, editing the key
 * line already present (in whichever of the three spellings) instead of
 * prepending a second copy, which would make the frontmatter invalid YAML. */
export function setDisableModelInvocation(content: string, disable: boolean): string {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return disable ? `---\n${CANONICAL_DISABLE_KEY}: true\n---\n${content}` : content;
  }

  const eol = match[0].includes("\r\n") ? "\r\n" : "\n";
  const lines = match[1].split(/\r?\n/);
  const hits = lines.reduce<number[]>((acc, line, index) => {
    if (DISABLE_KEY_LINE_RE.test(line)) acc.push(index);
    return acc;
  }, []);

  let next: string[];
  if (disable) {
    if (hits.length === 0) {
      next = [`${CANONICAL_DISABLE_KEY}: true`, ...lines];
    } else {
      // Keep the spelling the file already uses; drop any duplicate variants so
      // a stale `hide: true` cannot re-enable hiding on the next toggle.
      const keep = hits[0];
      const keyName = /^([\w-]+)/.exec(lines[keep])?.[1] ?? CANONICAL_DISABLE_KEY;
      next = lines
        .map((line, index) => (index === keep ? `${keyName}: true` : line))
        .filter((_, index) => index === keep || !hits.includes(index));
    }
  } else {
    if (hits.length === 0) return content;
    next = lines.filter((_, index) => !hits.includes(index));
  }

  const block = `---${eol}${next.join(eol)}${eol}---${match[2]}`;
  return block + content.slice(match[0].length);
}

/** `root.dir` is user-controlled and can be outside the app. Keep runtime
 * discovery opaque to Next's NFT tracer so builds never glob the user's
 * profile (or protected Windows junctions). */
function readDirEntries(dir: string) {
  const readDirectory = Reflect.get(fs, "readdir") as typeof fs.readdir;
  return readDirectory(dir, { withFileTypes: true });
}

/** Directories one level under a root, each a candidate skill package. */
async function flatSkillDirs(root: string): Promise<string[]> {
  const entries = await readDirEntries(root);
  return entries
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => path.join(root, entry.name));
}


async function scanRoot(root: SkillScanRoot, diagnostics: SkillDiagnostic[]): Promise<SkillInfo[]> {
  let skillDirs: string[];
  try {
    skillDirs = await flatSkillDirs(root.dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({
        type: "warning",
        message: `Failed to read skills directory: ${String(error)}`,
        path: root.dir,
      });
    }
    return [];
  }

  const skills: SkillInfo[] = [];
  await Promise.all(skillDirs.map(async (baseDir) => {
    const skillPath = path.join(baseDir, "SKILL.md");
    let content: string;
    try {
      content = await fs.readFile(skillPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push({ type: "warning", message: "Failed to read skill file", path: skillPath });
      }
      return;
    }
    const { frontmatter } = parseSkillFrontmatter(content);
    if (frontmatter.enabled === false) return;
    const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
    if (root.requireDescription && !description) return;
    const rawName = frontmatter.name;
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : path.basename(baseDir);
    skills.push({
      name,
      description,
      filePath: skillPath,
      baseDir,
      disableModelInvocation: readDisableModelInvocation(frontmatter),
      sourceInfo: { source: root.source, scope: root.scope },
    });
  }));
  return skills;
}

/** Discover skills for a cwd the way the active engine does. Name collisions
 * resolve to the highest-priority provider (scan-root order); result is sorted
 * by name. */
export async function discoverSkills(cwd: string): Promise<SkillsWithDiagnostics> {
  const diagnostics: SkillDiagnostic[] = [];
  const byName = new Map<string, SkillInfo>();
  for (const root of buildScanRoots(cwd)) {
    for (const skill of await scanRoot(root, diagnostics)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  const skills = [...byName.values()].sort((a, b) => {
    const cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return cmp !== 0 ? cmp : a.filePath.localeCompare(b.filePath);
  });
  return { skills, diagnostics };
}


export async function loadSkillsWithInstallInfo(cwd: string) {
  const harness = getHarness();
  const { skills, diagnostics } = await discoverSkills(cwd);
  const agentDir = harness.getAgentDir();
  return {
    skills: annotateSkillsWithInstallInfo(skills, { cwd, agentDir }),
    diagnostics,
  };
}

/**
 * What the active engine's skills surface can actually do, so the UI disables
 * the controls that would not work instead of failing on click.
 */
export interface SkillsSurface {
  installScopes: SkillInstallScope[];
  canToggle: boolean;
}

export function getSkillsSurface(): SkillsSurface {
  return { installScopes: ["global", "project"], canToggle: true };
}
