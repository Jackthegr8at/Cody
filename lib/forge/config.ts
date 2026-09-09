import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";

/**
 * Code hosts Cody talks to: GitHub, and any self-hosted Gitea.
 *
 * Why this exists: everything Cody knew about a code host used to be
 * `api.github.com` written into three unrelated files (skill updates, the app
 * update check, the agent's own tooling) plus whatever `GITHUB_TOKEN` happened
 * to be in the container's environment. A self-hosted forge could not be
 * reached at all, and there was no in-app way to say which host owns which
 * repository.
 *
 * One file answers all of it. It lives in the instance data dir beside the
 * provider keys, is written 0600 and atomically because it holds tokens, and
 * the values NEVER leave the server: the API reports which hosts exist and
 * whether each carries a token, never the token itself.
 *
 * With no file on disk the document is a single built-in GitHub host carrying
 * whatever `GITHUB_TOKEN`/`GH_TOKEN` the container was started with — exactly
 * what Cody did before this existed, so nothing changes until a host is added.
 */

const FILE_NAME = "cody-forge.json";

export type ForgeKind = "github" | "gitea";

export const BUILTIN_GITHUB_HOST_ID = "github";
export const GITHUB_BASE_URL = "https://github.com";
export const GITHUB_API_URL = "https://api.github.com";

export interface ForgeHost {
  id: string;
  kind: ForgeKind;
  label: string;
  /** Web origin, never a trailing slash: `https://git.example.net`. */
  baseUrl: string;
  /** Default account/organization for `repo` arguments that name no owner. */
  owner: string;
  token?: string;
}

/** Where this Cody looks for its own new versions. */
export interface ForgeUpdateSource {
  hostId: string;
  /** `owner/name` on that host. */
  repo: string;
  /** Container image reference, pulled to update a Docker deployment. */
  image: string;
}

export interface ForgeConfig {
  version: 1;
  hosts: ForgeHost[];
  defaultHostId?: string;
  codyUpdateSource?: ForgeUpdateSource;
}

/** The channel Cody shipped on before a forge existed. Unchanged until the
 * user points `codyUpdateSource` somewhere else. */
export const DEFAULT_CODY_UPDATE_SOURCE: ForgeUpdateSource = {
  hostId: BUILTIN_GITHUB_HOST_ID,
  repo: "nphil/Cody",
  image: "ghcr.io/nphil/cody:latest",
};

export function getForgeConfigPath(): string {
  return path.join(getAgentDir(), FILE_NAME);
}

function environmentGitHubToken(): string | undefined {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token && token.trim() ? token.trim() : undefined;
}

/** github.com specifically — a GitHub Enterprise host is not the place to
 * spend a token minted for the public one. */
function isGitHubDotCom(host: Pick<ForgeHost, "kind" | "baseUrl">): boolean {
  if (host.kind !== "github") return false;
  try {
    return new URL(host.baseUrl).hostname.toLowerCase().endsWith("github.com");
  } catch {
    return false;
  }
}

/** The host that exists whether or not anything was ever configured. No
 * `token`: that field means "an admin typed this into Settings", and the
 * container's `GITHUB_TOKEN` is picked up by `resolveToken` instead — so the
 * panel can say where the credential came from, and a saved one can override
 * it the way a provider key overrides its environment variable. */
export function builtinGitHubHost(): ForgeHost {
  return { id: BUILTIN_GITHUB_HOST_ID, kind: "github", label: "GitHub", baseUrl: GITHUB_BASE_URL, owner: "" };
}

function emptyConfig(): ForgeConfig {
  return { version: 1, hosts: [builtinGitHubHost()], defaultHostId: BUILTIN_GITHUB_HOST_ID };
}

function readHost(value: unknown): ForgeHost | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const kind = value.kind === "gitea" ? "gitea" : value.kind === "github" ? "github" : null;
  const baseUrl = typeof value.baseUrl === "string" ? normalizeBaseUrl(value.baseUrl) : "";
  if (!id || !kind || !baseUrl) return null;
  const token = typeof value.token === "string" && value.token.trim() ? value.token.trim() : undefined;
  return {
    id,
    kind,
    label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : id,
    baseUrl,
    owner: typeof value.owner === "string" ? value.owner.trim() : "",
    ...(token ? { token } : {}),
  };
}

function readUpdateSource(value: unknown): ForgeUpdateSource | undefined {
  if (!isRecord(value)) return undefined;
  const hostId = typeof value.hostId === "string" ? value.hostId.trim() : "";
  const repo = typeof value.repo === "string" ? value.repo.trim() : "";
  const image = typeof value.image === "string" ? value.image.trim() : "";
  if (!hostId || !repo) return undefined;
  return { hostId, repo, image: image || DEFAULT_CODY_UPDATE_SOURCE.image };
}

/** The stored document, tokens included. Server-side only. */
export function readForgeConfig(): ForgeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(getForgeConfigPath(), "utf8"));
  } catch {
    return emptyConfig();
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.hosts)) return emptyConfig();
  const hosts: ForgeHost[] = [];
  for (const entry of parsed.hosts) {
    const host = readHost(entry);
    if (host && !hosts.some((existing) => existing.id === host.id)) hosts.push(host);
  }
  // A file that lost every host is the un-configured state again, not a Cody
  // that can no longer reach any code host at all.
  if (hosts.length === 0) return emptyConfig();
  const requestedDefault = typeof parsed.defaultHostId === "string" ? parsed.defaultHostId : "";
  const defaultHostId = hosts.some((host) => host.id === requestedDefault) ? requestedDefault : hosts[0].id;
  const codyUpdateSource = readUpdateSource(parsed.codyUpdateSource);
  return { version: 1, hosts, defaultHostId, ...(codyUpdateSource ? { codyUpdateSource } : {}) };
}

/** Atomic replace, 0600 throughout: a crash mid-write can never truncate the
 * file, and nothing on the box but Cody can read it. */
function writeForgeConfig(config: ForgeConfig): void {
  const target = getForgeConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

// ── URLs ─────────────────────────────────────────────────────────────────────

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

const LAN_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa"];

/** A private address a browser on this network can actually reach. Plain HTTP
 * is only ever acceptable there: a token sent in the clear across the public
 * internet is a token given away. */
function isLanHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name === "::1" || name === "0.0.0.0") return true;
  if (!name.includes(".") && !name.includes(":")) return true; // bare hostname on the LAN
  if (LAN_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!ipv4) return name.startsWith("fc") || name.startsWith("fd") || name.startsWith("fe80:");
  const [a, b] = ipv4.slice(1).map(Number);
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** Null when the URL is usable, otherwise the reason it is not. */
export function validateBaseUrl(raw: string): string | null {
  const value = normalizeBaseUrl(raw);
  if (!value) return "A base URL is required";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL, for example https://git.example.net";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") return "Only http and https URLs are supported";
  return isLanHostname(url.hostname)
    ? null
    : "Plain http is only allowed for a private address; use https for a public host";
}

/** github: the public API, whatever the web origin says. gitea: the v1 API
 * always sits under the web origin. */
export function resolveApiUrl(host: Pick<ForgeHost, "kind" | "baseUrl">): string {
  return host.kind === "github" ? GITHUB_API_URL : `${normalizeBaseUrl(host.baseUrl)}/api/v1`;
}

/** The token a host actually authenticates with: what was saved, or the
 * container's `GITHUB_TOKEN`/`GH_TOKEN` for github.com. */
export function resolveToken(host: ForgeHost): string | undefined {
  if (host.token) return host.token;
  return isGitHubDotCom(host) ? environmentGitHubToken() : undefined;
}

/** GitHub reads a bearer; Gitea reads its own `token` scheme. Neither is
 * optional once a token exists, and neither header appears without one. */
export function authHeader(host: ForgeHost): Record<string, string> {
  const token = resolveToken(host);
  if (!token) return {};
  return { Authorization: host.kind === "github" ? `Bearer ${token}` : `token ${token}` };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface PublicForgeHost {
  id: string;
  kind: ForgeKind;
  label: string;
  baseUrl: string;
  apiUrl: string;
  owner: string;
  hasToken: boolean;
  /** Last four characters, so a saved token can be told apart from another
   * without the panel ever holding the value. */
  tokenPreview: string | null;
  tokenSource: "stored" | "environment" | null;
  isDefault: boolean;
  /** Seeded, not on disk: it exists because Cody always knows github.com, so
   * there is nothing to remove yet. The first write materializes the whole
   * document, and from then on GitHub is an ordinary entry — which is the
   * point, since an install that has moved to a self-hosted forge should be
   * able to drop it. */
  builtin: boolean;
}

function storedHostIds(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getForgeConfigPath(), "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.hosts)) return new Set();
    return new Set(parsed.hosts.map((entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : "")).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** What the panel and the API show: every host, no token values. */
export function listForgeHosts(): PublicForgeHost[] {
  const config = readForgeConfig();
  const stored = storedHostIds();
  return config.hosts.map((host) => {
    const token = resolveToken(host);
    return {
      id: host.id,
      kind: host.kind,
      label: host.label,
      baseUrl: host.baseUrl,
      apiUrl: resolveApiUrl(host),
      owner: host.owner,
      hasToken: Boolean(token),
      tokenPreview: token ? (token.length <= 4 ? "•".repeat(token.length) : token.slice(-4)) : null,
      tokenSource: host.token ? "stored" : token ? "environment" : null,
      isDefault: config.defaultHostId === host.id,
      builtin: !stored.has(host.id),
    };
  });
}

export function getForgeHost(id: string): ForgeHost | null {
  return readForgeConfig().hosts.find((host) => host.id === id) ?? null;
}

/** The host an operation runs against: the one named, else the default. */
export function resolveForgeHost(id?: string | null): ForgeHost | null {
  const config = readForgeConfig();
  if (id) return config.hosts.find((host) => host.id === id) ?? null;
  return config.hosts.find((host) => host.id === config.defaultHostId) ?? config.hosts[0] ?? null;
}

/** The configured host a clone/remote URL belongs to, with the `owner/name` it
 * names. Used to answer "which host is this checkout on?" without asking. */
export function matchForgeHostUrl(remoteUrl: string): { host: ForgeHost; repo: string } | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  // `git@host:owner/repo.git` is not a URL; rewrite it into one first.
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(trimmed);
  const normalized = scp ? `ssh://${scp[1]}/${scp[2]}` : trimmed.replace(/^git\+/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const repo = `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
  for (const host of readForgeConfig().hosts) {
    let hostName: string;
    try {
      hostName = new URL(host.baseUrl).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (hostName === hostname) return { host, repo };
  }
  return null;
}

/** Where this Cody checks for its own updates, with the host resolved. Falls
 * back to the built-in GitHub host so the default channel keeps working even
 * if the configured host id was removed. */
export function resolveCodyUpdateSource(): { source: ForgeUpdateSource; host: ForgeHost; isDefault: boolean } {
  const config = readForgeConfig();
  const configured = config.codyUpdateSource;
  const source = configured ?? DEFAULT_CODY_UPDATE_SOURCE;
  const host = config.hosts.find((candidate) => candidate.id === source.hostId);
  if (host) return { source, host, isDefault: configured === undefined };
  // A source pointing at a host that no longer exists is not a reason to stop
  // checking: fall back to the channel Cody ships on.
  const fallback = config.hosts.find((candidate) => candidate.id === DEFAULT_CODY_UPDATE_SOURCE.hostId);
  return { source: DEFAULT_CODY_UPDATE_SOURCE, host: fallback ?? builtinGitHubHost(), isDefault: true };
}

// ── Writes ───────────────────────────────────────────────────────────────────

export class ForgeConfigError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ForgeConfigError";
    this.code = code;
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface ForgeHostInput {
  id?: string;
  kind: ForgeKind;
  label: string;
  baseUrl: string;
  owner: string;
  /** Omitted keeps whatever is saved; an empty string clears it. */
  token?: string;
}

/** Create or replace one host. Returns the stored record (token included) so
 * the caller can test the credential it just saved. */
export function upsertForgeHost(input: ForgeHostInput): ForgeHost {
  const kind: ForgeKind = input.kind === "gitea" ? "gitea" : "github";
  const label = input.label.trim();
  if (!label) throw new ForgeConfigError("A name is required", "label_required");
  // GitHub's API base is fixed, so its web origin is too — accepting anything
  // else would silently pair github.com's API with someone else's repos.
  const baseUrl = kind === "github" ? GITHUB_BASE_URL : normalizeBaseUrl(input.baseUrl);
  const invalid = validateBaseUrl(baseUrl);
  if (invalid) throw new ForgeConfigError(invalid, "invalid_base_url");

  const id = (input.id ?? "").trim() || label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!ID_RE.test(id)) throw new ForgeConfigError("Invalid host id", "invalid_host_id");

  const config = readForgeConfig();
  const existing = config.hosts.find((host) => host.id === id);
  const token = input.token === undefined ? existing?.token : input.token.trim() || undefined;
  const host: ForgeHost = { id, kind, label, baseUrl, owner: input.owner.trim(), ...(token ? { token } : {}) };

  const hosts = existing
    ? config.hosts.map((candidate) => (candidate.id === id ? host : candidate))
    : [...config.hosts, host];
  writeForgeConfig({ ...config, hosts, defaultHostId: config.defaultHostId ?? id });
  return host;
}

/** Remove a host. The last one cannot go: with no hosts at all the file reads
 * back as un-configured and the built-in GitHub entry would reappear anyway. */
export function removeForgeHost(id: string): boolean {
  const config = readForgeConfig();
  const hosts = config.hosts.filter((host) => host.id !== id);
  if (hosts.length === config.hosts.length) return false;
  if (hosts.length === 0) throw new ForgeConfigError("The last code host cannot be removed", "last_host");
  const defaultHostId = hosts.some((host) => host.id === config.defaultHostId) ? config.defaultHostId : hosts[0].id;
  const codyUpdateSource = config.codyUpdateSource?.hostId === id ? undefined : config.codyUpdateSource;
  writeForgeConfig({ version: 1, hosts, defaultHostId, ...(codyUpdateSource ? { codyUpdateSource } : {}) });
  return true;
}

export function setDefaultForgeHost(id: string): void {
  const config = readForgeConfig();
  if (!config.hosts.some((host) => host.id === id)) {
    throw new ForgeConfigError("Unknown code host", "unknown_host");
  }
  writeForgeConfig({ ...config, defaultHostId: id });
}

/** Point Cody's own update check at a host, or `null` to restore the default
 * GitHub channel. */
export function setCodyUpdateSource(source: ForgeUpdateSource | null): void {
  const config = readForgeConfig();
  if (!source) {
    writeForgeConfig({ version: 1, hosts: config.hosts, defaultHostId: config.defaultHostId });
    return;
  }
  if (!config.hosts.some((host) => host.id === source.hostId)) {
    throw new ForgeConfigError("Unknown code host", "unknown_host");
  }
  const repo = source.repo.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new ForgeConfigError("Repository must be owner/name", "invalid_repo");
  }
  writeForgeConfig({
    ...config,
    codyUpdateSource: { hostId: source.hostId, repo, image: source.image.trim() || DEFAULT_CODY_UPDATE_SOURCE.image },
  });
}
