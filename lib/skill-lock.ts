import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { BUILTIN_GITHUB_HOST_ID, matchForgeHostUrl } from "./forge/config";
import type { SkillInfo, SkillInstallInfo, SkillInstallScope } from "@/lib/api-types";

interface SkillLockEntry {
  source?: unknown;
  sourceType?: unknown;
  skillPath?: unknown;
  ref?: unknown;
  skillFolderHash?: unknown;
  computedHash?: unknown;
}

interface SkillLockFile {
  skills?: Record<string, SkillLockEntry>;
}

interface GlobalLockPathOptions {
  homeDir?: string;
  xdgStateHome?: string;
}

interface AnnotateSkillOptions {
  cwd: string;
  agentDir: string;
  globalLockPath?: string;
  projectLockPath?: string;
}

export function getGlobalSkillsLockPath(options: GlobalLockPathOptions = {}): string {
  const homeDir = options.homeDir ?? homedir();
  // Callers that inject a home directory (tests or alternate installations)
  // must not accidentally inherit the host process's XDG state directory.
  const xdgStateHome = options.xdgStateHome ?? (options.homeDir === undefined ? process.env.XDG_STATE_HOME : undefined);
  return xdgStateHome
    ? join(xdgStateHome, "skills", ".skill-lock.json")
    : join(homeDir, ".agents", ".skill-lock.json");
}

function readSkillLock(path: string): Record<string, SkillLockEntry> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SkillLockFile;
    return parsed.skills && typeof parsed.skills === "object" ? parsed.skills : {};
  } catch {
    return {};
  }
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function findLockEntry(
  entries: Record<string, SkillLockEntry>,
  skillName: string,
): SkillLockEntry | undefined {
  if (entries[skillName]) return entries[skillName];
  const normalizedName = skillName.toLowerCase();
  const key = Object.keys(entries).find((name) => name.toLowerCase() === normalizedName);
  return key ? entries[key] : undefined;
}

function normalizeSource(source: string, sourceType?: string): string {
  if (sourceType !== "github") return source.replace(/\/$/, "");
  return source
    .replace(/^git\+/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function buildSkillsShUrl(source: string, skillName: string): string | undefined {
  if (!source || source.includes("://") || source.startsWith("git@")) return undefined;
  const sourcePath = source
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  if (!sourcePath) return undefined;
  return `https://skills.sh/${sourcePath}/${encodeURIComponent(skillName)}`;
}

function getInstallInfo(
  entries: Record<string, SkillLockEntry>,
  skillName: string,
  scope: SkillInstallScope,
): SkillInstallInfo | undefined {
  const entry = findLockEntry(entries, skillName);
  if (!entry || typeof entry.source !== "string" || !entry.source.trim()) return undefined;

  const sourceType = typeof entry.sourceType === "string" ? entry.sourceType : undefined;
  const raw = entry.source.trim();
  // A source that is a URL on a code host Cody knows (a self-hosted Gitea, or
  // github.com written out in full) collapses to the same owner/repo an
  // `owner/repo` source already is, and remembers which host it came from —
  // that is what makes a skill hosted off github.com checkable at all.
  const matched = matchForgeHostUrl(raw);
  const source = matched ? matched.repo : normalizeSource(raw, sourceType);
  if (!source) return undefined;
  const forgeHostId = matched
    ? matched.host.id
    : sourceType === "github"
      ? BUILTIN_GITHUB_HOST_ID
      : undefined;
  const skillPath = typeof entry.skillPath === "string" ? entry.skillPath : undefined;
  const ref = typeof entry.ref === "string" ? entry.ref : undefined;
  const rawVersionHash = scope === "global" ? entry.skillFolderHash : entry.computedHash;
  const versionHash = typeof rawVersionHash === "string" && rawVersionHash
    ? rawVersionHash
    : undefined;
  // A repository on a known host, named owner/repo: the shape both GitHub's
  // and Gitea's git-tree API can be asked about.
  const isRepositorySource = Boolean(forgeHostId) && /^[\w.-]+\/[\w.-]+$/.test(source);
  const hasComparableVersion = scope === "global" || !ref;

  return {
    package: `${source}@${skillName}`,
    scope,
    source,
    sourceType,
    skillsShUrl: sourceType === "local" ? undefined : buildSkillsShUrl(source, skillName),
    ...(skillPath && { skillPath }),
    ...(ref && { ref }),
    ...(versionHash && { versionHash }),
    ...(forgeHostId && { forgeHostId }),
    canCheckForUpdates: Boolean(
      isRepositorySource && skillPath && versionHash && hasComparableVersion,
    ),
  };
}

export function annotateSkillsWithInstallInfo(
  skills: SkillInfo[],
  {
    cwd,
    agentDir,
    globalLockPath = getGlobalSkillsLockPath(),
    projectLockPath = join(cwd, "skills-lock.json"),
  }: AnnotateSkillOptions,
): SkillInfo[] {
  const globalEntries = readSkillLock(globalLockPath);
  const projectEntries = readSkillLock(projectLockPath);
  // skills.sh installs with --agent universal land in .agents/skills; omp's
  // own dirs remain valid install roots for manually placed skills.
  const globalSkillsRoots = [join(agentDir, "skills"), join(homedir(), ".agents", "skills")];
  const projectSkillsRoots = [join(cwd, ".omp", "skills"), join(cwd, ".agents", "skills")];

  return skills.map((skill) => {
    if (!existsSync(skill.filePath)) return skill;

    const install = globalSkillsRoots.some((root) => isWithin(skill.filePath, root))
      ? getInstallInfo(globalEntries, skill.name, "global")
      : projectSkillsRoots.some((root) => isWithin(skill.filePath, root))
        ? getInstallInfo(projectEntries, skill.name, "project")
        : undefined;

    return install ? { ...skill, install } : skill;
  });
}
