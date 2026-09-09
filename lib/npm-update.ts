import packageJson from "../package.json";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, normalize, sep } from "path";
import { readEnv } from "./env";
import { createForgeClient, parseRepoRef } from "./forge/client";
import { resolveCodyUpdateSource, type ForgeHost } from "./forge/config";

const NPM_PACKAGE = "@nphil/cody";
/** Docker writes this marker into every container it builds. */
const CONTAINER_MARKER = "/.dockerenv";
const CHECK_TTL_MS = 60 * 60 * 1000;

/** Where a container deployment's next version comes from. Defaults to the
 * GitHub repo Cody has always shipped from; a self-hosted forge replaces it
 * wholesale (Settings › Code hosts), which is what makes an install that never
 * talks to github.com possible. */
export interface AppUpdateSource {
  hostId: string;
  hostLabel: string;
  kind: "github" | "gitea";
  /** `owner/name` on that host. */
  repo: string;
  image: string;
  /** False once the user has pointed Cody somewhere else. */
  isDefault: boolean;
}

export interface NpmUpdateStatus {
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
  /** Which channel actually ships to this deployment, so the card can name
   * the one update path that works here instead of assuming a CLI install. */
  managedBy: "docker" | "npm" | "bun";
  /** The release feed the container channel compared against; null outside a
   * container, where npm is the only channel and no code host is involved. */
  source: AppUpdateSource | null;
  /** The newest release's own page, for "what changed". */
  releaseUrl: string | null;
}

let cached: { checkedAt: number; status: NpmUpdateStatus } | null = null;

function parseVersion(version: string): { parts: number[]; prerelease: boolean } | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/);
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) };
}

export function isNewerVersion(availableVersion: string, currentVersion: string): boolean {
  const available = parseVersion(availableVersion);
  const current = parseVersion(currentVersion);
  if (!available || !current) return false;

  for (let index = 0; index < available.parts.length; index += 1) {
    if (available.parts[index] !== current.parts[index]) {
      return available.parts[index] > current.parts[index];
    }
  }
  return !available.prerelease && current.prerelease;
}

/** The npm registry publishes the CLI install; a code host's releases feed
 * publishes the container image. Each deployment has to be compared against
 * the channel that ships to it, or the card reports a version nobody here
 * can install (the image build is not on npm at all).
 *
 * The container channel goes through the forge client, so a Cody whose update
 * source points at a self-hosted Gitea never touches github.com: both hosts
 * answer `/repos/{owner}/{name}/releases/latest` with the same `tag_name`,
 * `body` and `html_url`. */
async function fetchLatestRelease(host: ForgeHost, repo: string): Promise<{ version: string | null; releaseUrl: string | null }> {
  const release = await createForgeClient(host, { timeoutMs: 5_000 }).releaseLatest(parseRepoRef(repo, host.owner));
  if (!release) return { version: null, releaseUrl: null };
  // Release tags are shaped `v0.9.0`; the bare semver is what compares.
  return { version: release.tagName.replace(/^v/, "") || null, releaseUrl: release.htmlUrl || null };
}

async function fetchLatestNpmVersion(): Promise<string | null> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  const data = response.ok ? await response.json() as { version?: unknown } : null;
  return typeof data?.version === "string" ? data.version : null;
}

/** Drop the hourly cache, so a code host or update source saved a moment ago
 * is the one the next read compares against. */
export function invalidateAppUpdateCache(): void {
  cached = null;
}

/** `markerPath` is a test seam: production callers omit it and get the real
 * container marker. */
export async function checkNpmUpdate(force = false, markerPath?: string): Promise<NpmUpdateStatus> {
  if (!force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.status;

  const currentVersion = packageJson.version;
  const managedBy: NpmUpdateStatus["managedBy"] = detectContainerDeployment(markerPath)
    ? "docker"
    : detectInstallMethod(readEnv("PACKAGE_DIR") ?? process.cwd());

  const configured = resolveCodyUpdateSource();
  const source: AppUpdateSource | null = managedBy === "docker"
    ? {
      hostId: configured.host.id,
      hostLabel: configured.host.label,
      kind: configured.host.kind,
      repo: configured.source.repo,
      image: configured.source.image,
      isDefault: configured.isDefault,
    }
    : null;

  const updateCommand = managedBy === "docker"
    ? `docker pull ${configured.source.image}`
    : managedBy === "bun"
      ? `bun add -g ${NPM_PACKAGE}`
      : `npm install -g ${NPM_PACKAGE}`;

  try {
    const { version, releaseUrl } = managedBy === "docker"
      ? await fetchLatestRelease(configured.host, configured.source.repo)
      : { version: await fetchLatestNpmVersion(), releaseUrl: null };
    const status: NpmUpdateStatus = {
      currentVersion,
      availableVersion: version,
      updateAvailable: Boolean(version && isNewerVersion(version, currentVersion)),
      updateCommand,
      managedBy,
      source,
      releaseUrl,
    };
    cached = { checkedAt: Date.now(), status };
    return status;
  } catch {
    return { currentVersion, availableVersion: null, updateAvailable: false, updateCommand, managedBy, source, releaseUrl: null };
  }
}

/** Whether this instance runs from a container image, which is updated by
 * pulling the image again rather than through a package manager. The marker
 * path is injectable so tests can drive both branches without writing to the
 * filesystem root. */
export function detectContainerDeployment(markerPath: string = CONTAINER_MARKER): boolean {
  return existsSync(markerPath);
}

/** Which package manager owns a given install dir, so updates always run
 * through the manager that manages it (bun global root, npm global root,
 * anything else → npm as the fallback). Separators are normalized so the
 * classification is deterministic even when a Windows-style path is passed
 * on a POSIX host (e.g. in CI tests). */
export function detectInstallMethod(packageDir: string): "bun" | "npm" {
  const toPlatformPath = (value: string): string => normalize(value).replaceAll("\\", sep);
  const normalized = toPlatformPath(packageDir);
  const bunRoots = [
    // bun 1.3.x globals on Windows live in ~/node_modules; POSIX uses the
    // standard ~/.bun/install/global/node_modules.
    join(process.env.USERPROFILE ?? process.env.HOME ?? "", "node_modules"),
    join(homedir(), ".bun", "install", "global", "node_modules"),
  ].map(toPlatformPath);
  return bunRoots.some((root) => normalized.startsWith(root + sep)) ? "bun" : "npm";
}

