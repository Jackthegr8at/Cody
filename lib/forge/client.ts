import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { authHeader, resolveApiUrl, type ForgeHost, type ForgeKind } from "./config";

/**
 * One client, two code hosts.
 *
 * GitHub and Gitea are close enough that a shared interface is honest rather
 * than a lowest common denominator: Gitea deliberately mirrors GitHub's JSON
 * for repositories, issues, pull requests, releases and Actions runs. Where
 * they genuinely differ — pagination (`per_page` vs `limit`), a repository's
 * star field, how a diff is asked for, how a release asset is uploaded, where
 * packages live — the difference lives in one of the two subclasses and
 * nowhere else.
 *
 * Everything returned is a compact shape with the fields an agent actually
 * reads. Raw upstream bodies are never forwarded: they are large, they differ
 * in ways that do not matter, and they carry account details nobody asked for.
 *
 * `fetch` only — no octokit. Cody must be able to talk to a self-hosted forge
 * with no dependency that assumes github.com.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "cody";

export type ForgeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ForgeClientOptions {
  /** Test seam, and the request-dedupe wrapper skill updates already uses. */
  fetcher?: ForgeFetch;
  timeoutMs?: number;
}

export class ForgeError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ForgeError";
    this.status = status;
  }
}

export interface ForgeRepoRef {
  owner: string;
  name: string;
}

/** `owner/name`, or a bare `name` against the host's default owner. */
export function parseRepoRef(value: string, fallbackOwner: string): ForgeRepoRef {
  const cleaned = value.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!cleaned) throw new ForgeError("A repository is required, as owner/name");
  const parts = cleaned.split("/");
  if (parts.length === 1) {
    if (!fallbackOwner) throw new ForgeError(`No default owner for this host: name the repository as owner/${parts[0]}`);
    return { owner: fallbackOwner, name: parts[0] };
  }
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ForgeError(`Invalid repository "${value}": use owner/name`);
  return { owner: parts[0], name: parts[1] };
}

// ── Compact shapes ───────────────────────────────────────────────────────────

export interface ForgeIdentity {
  login: string;
  name?: string;
  /** Gitea reports its own version; GitHub does not, so this is null there. */
  serverVersion: string | null;
}

export interface ForgeRepoSummary {
  fullName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  stars: number;
  openIssues: number;
  updatedAt: string;
  htmlUrl: string;
  cloneUrl: string;
}

export interface ForgeFileContent {
  path: string;
  ref: string;
  sha: string;
  size: number;
  /** Decoded when the file is text; null for a binary blob (see `binary`). */
  text: string | null;
  binary: boolean;
  truncated: boolean;
}

export interface ForgeIssueSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface ForgeComment {
  author: string;
  createdAt: string;
  body: string;
}

export interface ForgeIssueDetail extends ForgeIssueSummary {
  body: string;
  commentList?: ForgeComment[];
}

export interface ForgePullSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  merged: boolean;
  author: string;
  head: string;
  base: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface ForgePullDetail extends ForgePullSummary {
  body: string;
  mergeable: boolean | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

export interface ForgeReleaseAsset {
  id: number;
  name: string;
  size: number;
  downloadUrl: string;
}

export interface ForgeRelease {
  id: number;
  tagName: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string;
  htmlUrl: string;
  body: string;
  assets: ForgeReleaseAsset[];
}

export interface ForgeRun {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  event: string;
  branch: string;
  headSha: string;
  runNumber: number;
  htmlUrl: string;
  startedAt: string;
  completedAt: string;
}

export interface ForgeJob {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  runnerName: string;
  startedAt: string;
  completedAt: string;
  failedSteps: string[];
}

export interface ForgePackage {
  name: string;
  type: string;
  version: string;
  createdAt: string;
  htmlUrl: string;
}

export interface ForgeTreeEntry {
  path: string;
  type: string;
  sha: string;
}

export interface ForgeTree {
  sha: string;
  truncated: boolean;
  entries: ForgeTreeEntry[];
}

export interface ForgeListOptions {
  state?: "open" | "closed" | "all";
  limit?: number;
}

export interface ForgeRunListOptions {
  limit?: number;
  branch?: string;
  event?: string;
  status?: string;
}

export interface ForgeReleaseInput {
  tag: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  target?: string;
}

export interface ForgePullInput {
  head: string;
  base: string;
  title: string;
  body?: string;
}

export interface ForgeClient {
  readonly host: ForgeHost;
  readonly kind: ForgeKind;
  readonly apiUrl: string;
  whoami(): Promise<ForgeIdentity>;
  repoView(repo: ForgeRepoRef): Promise<ForgeRepoSummary>;
  fileRead(repo: ForgeRepoRef, filePath: string, ref?: string): Promise<ForgeFileContent>;
  issues(repo: ForgeRepoRef, options?: ForgeListOptions): Promise<ForgeIssueSummary[]>;
  issueView(repo: ForgeRepoRef, index: number, withComments?: boolean): Promise<ForgeIssueDetail>;
  pulls(repo: ForgeRepoRef, options?: ForgeListOptions): Promise<ForgePullSummary[]>;
  pullView(repo: ForgeRepoRef, index: number): Promise<ForgePullDetail>;
  pullDiff(repo: ForgeRepoRef, index: number): Promise<string>;
  pullCreate(repo: ForgeRepoRef, input: ForgePullInput): Promise<ForgePullDetail>;
  releases(repo: ForgeRepoRef, limit?: number): Promise<ForgeRelease[]>;
  releaseLatest(repo: ForgeRepoRef): Promise<ForgeRelease | null>;
  releaseCreate(repo: ForgeRepoRef, input: ForgeReleaseInput): Promise<ForgeRelease>;
  releaseUpload(repo: ForgeRepoRef, releaseId: number, file: Blob, fileName: string): Promise<ForgeReleaseAsset>;
  runs(repo: ForgeRepoRef, options?: ForgeRunListOptions): Promise<ForgeRun[]>;
  runView(repo: ForgeRepoRef, runId: number): Promise<ForgeRun>;
  runJobs(repo: ForgeRepoRef, runId: number): Promise<ForgeJob[]>;
  jobLogs(repo: ForgeRepoRef, jobId: number): Promise<string>;
  packages(owner: string, limit?: number): Promise<ForgePackage[]>;
  gitTree(repo: ForgeRepoRef, ref: string, recursive?: boolean): Promise<ForgeTree>;
}

// ── Shared plumbing ──────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function login(value: unknown): string {
  return text(record(value).login) || text(record(value).username);
}

function labelNames(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => text(record(entry).name)).filter(Boolean) : [];
}

function branchLabel(value: unknown): string {
  const side = record(value);
  return text(side.label) || text(side.ref) || text(side.sha).slice(0, 12);
}

abstract class BaseForgeClient implements ForgeClient {
  readonly apiUrl: string;
  protected readonly fetcher: ForgeFetch;
  protected readonly timeoutMs: number;

  constructor(readonly host: ForgeHost, options: ForgeClientOptions = {}) {
    this.apiUrl = resolveApiUrl(host);
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get kind(): ForgeKind {
    return this.host.kind;
  }

  protected headers(): Record<string, string> {
    return {
      // GitHub versions its API through Accept and answers a bare
      // application/json with a deprecated shape; Gitea speaks plain JSON.
      Accept: this.host.kind === "github" ? "application/vnd.github+json" : "application/json",
      "User-Agent": USER_AGENT,
      ...authHeader(this.host),
    };
  }

  protected async send(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
        ...init,
        headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (error) {
      throw new ForgeError(`${this.host.label} is unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const message = text(record(safeJson(detail)).message) || detail.slice(0, 200);
      throw new ForgeError(`${this.host.label} answered HTTP ${response.status}${message ? `: ${message}` : ""}`, response.status);
    }
    return response;
  }

  protected async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.send(`${this.apiUrl}${path}`, init)).json()) as T;
  }

  protected async plain(path: string, accept?: string): Promise<string> {
    const response = await this.send(`${this.apiUrl}${path}`, {
      headers: { Accept: accept ?? "text/plain" },
    });
    return response.text();
  }

  /** `?a=1&b=2`, skipping anything unset — every list endpoint builds one. */
  protected query(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") search.set(key, String(value));
    }
    const rendered = search.toString();
    return rendered ? `?${rendered}` : "";
  }

  protected repoPath(repo: ForgeRepoRef): string {
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  }

  protected mapIssue(raw: unknown): ForgeIssueSummary {
    const value = record(raw);
    return {
      number: count(value.number),
      title: text(value.title),
      state: text(value.state),
      author: login(value.user),
      labels: labelNames(value.labels),
      comments: count(value.comments),
      createdAt: text(value.created_at),
      updatedAt: text(value.updated_at),
      htmlUrl: text(value.html_url),
    };
  }

  protected mapPull(raw: unknown): ForgePullDetail {
    const value = record(raw);
    return {
      number: count(value.number),
      title: text(value.title),
      state: text(value.state),
      draft: value.draft === true,
      merged: value.merged === true,
      author: login(value.user),
      head: branchLabel(value.head),
      base: branchLabel(value.base),
      createdAt: text(value.created_at),
      updatedAt: text(value.updated_at),
      htmlUrl: text(value.html_url),
      body: text(value.body),
      mergeable: typeof value.mergeable === "boolean" ? value.mergeable : null,
      additions: typeof value.additions === "number" ? value.additions : null,
      deletions: typeof value.deletions === "number" ? value.deletions : null,
      changedFiles: typeof value.changed_files === "number" ? value.changed_files : null,
    };
  }

  protected mapRelease(raw: unknown): ForgeRelease {
    const value = record(raw);
    const assets = Array.isArray(value.assets) ? value.assets : [];
    return {
      id: count(value.id),
      tagName: text(value.tag_name),
      name: text(value.name),
      draft: value.draft === true,
      prerelease: value.prerelease === true,
      publishedAt: text(value.published_at),
      htmlUrl: text(value.html_url),
      body: text(value.body),
      assets: assets.map((entry) => {
        const asset = record(entry);
        return {
          id: count(asset.id),
          name: text(asset.name),
          size: count(asset.size),
          downloadUrl: text(asset.browser_download_url),
        };
      }),
    };
  }

  /** Gitea and GitHub agree on the run and job payloads (Gitea copied them),
   * so one mapper serves both. */
  protected mapRun(raw: unknown): ForgeRun {
    const value = record(raw);
    return {
      id: count(value.id),
      name: text(value.display_title) || text(value.name) || text(value.path),
      status: text(value.status),
      conclusion: text(value.conclusion),
      event: text(value.event),
      branch: text(value.head_branch),
      headSha: text(value.head_sha).slice(0, 12),
      runNumber: count(value.run_number),
      htmlUrl: text(value.html_url),
      startedAt: text(value.started_at) || text(value.run_started_at) || text(value.created_at),
      completedAt: text(value.completed_at) || text(value.updated_at),
    };
  }

  protected mapJob(raw: unknown): ForgeJob {
    const value = record(raw);
    const steps = Array.isArray(value.steps) ? value.steps : [];
    return {
      id: count(value.id),
      name: text(value.name),
      status: text(value.status),
      conclusion: text(value.conclusion),
      runnerName: text(value.runner_name),
      startedAt: text(value.started_at),
      completedAt: text(value.completed_at),
      failedSteps: steps
        .map((entry) => record(entry))
        .filter((step) => text(step.conclusion) === "failure")
        .map((step) => text(step.name)),
    };
  }

  protected mapTree(raw: unknown): ForgeTree {
    const value = record(raw);
    const entries = Array.isArray(value.tree) ? value.tree : [];
    return {
      sha: text(value.sha),
      truncated: value.truncated === true,
      entries: entries.map((entry) => {
        const node = record(entry);
        return { path: text(node.path), type: text(node.type), sha: text(node.sha) };
      }),
    };
  }

  /** Both hosts answer `/contents/{path}` with base64, and both mark a file
   * they refused to inline. */
  protected mapContents(raw: unknown, ref: string): ForgeFileContent {
    const value = record(raw);
    if (text(value.type) === "dir" || Array.isArray(raw)) {
      throw new ForgeError("That path is a directory, not a file");
    }
    const encoding = text(value.encoding);
    const encoded = text(value.content);
    let decoded: string | null = null;
    let binary = false;
    if (encoding === "base64" && encoded) {
      const buffer = Buffer.from(encoded, "base64");
      binary = buffer.includes(0);
      decoded = binary ? null : buffer.toString("utf8");
    } else if (encoding === "" && encoded) {
      decoded = encoded;
    }
    return {
      path: text(value.path),
      ref,
      sha: text(value.sha),
      size: count(value.size),
      text: decoded,
      binary,
      truncated: decoded === null && !binary,
    };
  }

  abstract whoami(): Promise<ForgeIdentity>;
  abstract repoView(repo: ForgeRepoRef): Promise<ForgeRepoSummary>;
  abstract issues(repo: ForgeRepoRef, options?: ForgeListOptions): Promise<ForgeIssueSummary[]>;
  abstract pulls(repo: ForgeRepoRef, options?: ForgeListOptions): Promise<ForgePullSummary[]>;
  abstract pullDiff(repo: ForgeRepoRef, index: number): Promise<string>;
  abstract releases(repo: ForgeRepoRef, limit?: number): Promise<ForgeRelease[]>;
  abstract releaseUpload(repo: ForgeRepoRef, releaseId: number, file: Blob, fileName: string): Promise<ForgeReleaseAsset>;
  abstract runs(repo: ForgeRepoRef, options?: ForgeRunListOptions): Promise<ForgeRun[]>;
  abstract packages(owner: string, limit?: number): Promise<ForgePackage[]>;
  abstract gitTree(repo: ForgeRepoRef, ref: string, recursive?: boolean): Promise<ForgeTree>;

  async fileRead(repo: ForgeRepoRef, filePath: string, ref?: string): Promise<ForgeFileContent> {
    const cleaned = filePath.replace(/^\/+/, "");
    const encoded = cleaned.split("/").map(encodeURIComponent).join("/");
    const body = await this.json<unknown>(`${this.repoPath(repo)}/contents/${encoded}${this.query({ ref })}`);
    return this.mapContents(body, ref ?? "");
  }

  async issueView(repo: ForgeRepoRef, index: number, withComments = false): Promise<ForgeIssueDetail> {
    const raw = await this.json<Record<string, unknown>>(`${this.repoPath(repo)}/issues/${index}`);
    const detail: ForgeIssueDetail = { ...this.mapIssue(raw), body: text(raw.body) };
    if (!withComments) return detail;
    const comments = await this.json<unknown[]>(`${this.repoPath(repo)}/issues/${index}/comments`);
    detail.commentList = (Array.isArray(comments) ? comments : []).map((entry) => {
      const comment = record(entry);
      return { author: login(comment.user), createdAt: text(comment.created_at), body: text(comment.body) };
    });
    return detail;
  }

  async pullView(repo: ForgeRepoRef, index: number): Promise<ForgePullDetail> {
    return this.mapPull(await this.json<unknown>(`${this.repoPath(repo)}/pulls/${index}`));
  }

  async pullCreate(repo: ForgeRepoRef, input: ForgePullInput): Promise<ForgePullDetail> {
    const raw = await this.json<unknown>(`${this.repoPath(repo)}/pulls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ head: input.head, base: input.base, title: input.title, body: input.body ?? "" }),
    });
    return this.mapPull(raw);
  }

  async releaseLatest(repo: ForgeRepoRef): Promise<ForgeRelease | null> {
    try {
      return this.mapRelease(await this.json<unknown>(`${this.repoPath(repo)}/releases/latest`));
    } catch (error) {
      if (error instanceof ForgeError && error.status === 404) return null;
      throw error;
    }
  }

  async releaseCreate(repo: ForgeRepoRef, input: ForgeReleaseInput): Promise<ForgeRelease> {
    const raw = await this.json<unknown>(`${this.repoPath(repo)}/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: input.tag,
        name: input.name ?? input.tag,
        body: input.body ?? "",
        draft: input.draft === true,
        prerelease: input.prerelease === true,
        ...(input.target ? { target_commitish: input.target } : {}),
      }),
    });
    return this.mapRelease(raw);
  }

  async runView(repo: ForgeRepoRef, runId: number): Promise<ForgeRun> {
    return this.mapRun(await this.json<unknown>(`${this.repoPath(repo)}/actions/runs/${runId}`));
  }

  async runJobs(repo: ForgeRepoRef, runId: number): Promise<ForgeJob[]> {
    const body = record(await this.json<unknown>(`${this.repoPath(repo)}/actions/runs/${runId}/jobs`));
    const jobs = Array.isArray(body.jobs) ? body.jobs : [];
    return jobs.map((entry) => this.mapJob(entry));
  }

  async jobLogs(repo: ForgeRepoRef, jobId: number): Promise<string> {
    return this.plain(`${this.repoPath(repo)}/actions/jobs/${jobId}/logs`, "text/plain, application/json");
  }
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// ── GitHub ───────────────────────────────────────────────────────────────────

class GitHubForgeClient extends BaseForgeClient {
  async whoami(): Promise<ForgeIdentity> {
    const user = record(await this.json<unknown>("/user"));
    return { login: text(user.login), name: text(user.name) || undefined, serverVersion: null };
  }

  async repoView(repo: ForgeRepoRef): Promise<ForgeRepoSummary> {
    const value = record(await this.json<unknown>(this.repoPath(repo)));
    return {
      fullName: text(value.full_name),
      description: text(value.description),
      defaultBranch: text(value.default_branch),
      private: value.private === true,
      archived: value.archived === true,
      fork: value.fork === true,
      stars: count(value.stargazers_count),
      openIssues: count(value.open_issues_count),
      updatedAt: text(value.pushed_at) || text(value.updated_at),
      htmlUrl: text(value.html_url),
      cloneUrl: text(value.clone_url),
    };
  }

  async issues(repo: ForgeRepoRef, options: ForgeListOptions = {}): Promise<ForgeIssueSummary[]> {
    const query = this.query({ state: options.state ?? "open", per_page: options.limit ?? 30 });
    const body = await this.json<unknown[]>(`${this.repoPath(repo)}/issues${query}`);
    // GitHub's issue list includes pull requests; Gitea's does not. Drop them
    // here so `issues` means the same thing on both hosts.
    return (Array.isArray(body) ? body : [])
      .filter((entry) => record(entry).pull_request === undefined)
      .map((entry) => this.mapIssue(entry));
  }

  async pulls(repo: ForgeRepoRef, options: ForgeListOptions = {}): Promise<ForgePullSummary[]> {
    const query = this.query({ state: options.state ?? "open", per_page: options.limit ?? 30 });
    const body = await this.json<unknown[]>(`${this.repoPath(repo)}/pulls${query}`);
    return (Array.isArray(body) ? body : []).map((entry) => this.mapPull(entry));
  }

  async pullDiff(repo: ForgeRepoRef, index: number): Promise<string> {
    return this.plain(`${this.repoPath(repo)}/pulls/${index}`, "application/vnd.github.diff");
  }

  async releases(repo: ForgeRepoRef, limit = 20): Promise<ForgeRelease[]> {
    const body = await this.json<unknown[]>(`${this.repoPath(repo)}/releases${this.query({ per_page: limit })}`);
    return (Array.isArray(body) ? body : []).map((entry) => this.mapRelease(entry));
  }

  /** GitHub uploads assets to a different origin, named by the release's own
   * `upload_url` RFC 6570 template, and takes the bytes as the raw body. */
  async releaseUpload(repo: ForgeRepoRef, releaseId: number, file: Blob, fileName: string): Promise<ForgeReleaseAsset> {
    const release = record(await this.json<unknown>(`${this.repoPath(repo)}/releases/${releaseId}`));
    const template = text(release.upload_url);
    const base = template ? template.replace(/\{[^}]*\}$/, "") : "";
    if (!base) throw new ForgeError("The release did not provide an upload URL");
    const url = `${base}?name=${encodeURIComponent(fileName)}`;
    const response = await this.send(url, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const asset = record(await response.json());
    return {
      id: count(asset.id),
      name: text(asset.name),
      size: count(asset.size),
      downloadUrl: text(asset.browser_download_url),
    };
  }

  async runs(repo: ForgeRepoRef, options: ForgeRunListOptions = {}): Promise<ForgeRun[]> {
    const query = this.query({
      per_page: options.limit ?? 20,
      branch: options.branch,
      event: options.event,
      status: options.status,
    });
    const body = record(await this.json<unknown>(`${this.repoPath(repo)}/actions/runs${query}`));
    const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
    return runs.map((entry) => this.mapRun(entry));
  }

  /** A user account and an organization have different package endpoints and
   * only one of them answers, so the other 404 is expected, not a failure. */
  async packages(owner: string, limit = 30): Promise<ForgePackage[]> {
    const query = this.query({ package_type: "container", per_page: limit });
    let body: unknown;
    try {
      body = await this.json<unknown>(`/users/${encodeURIComponent(owner)}/packages${query}`);
    } catch (error) {
      if (!(error instanceof ForgeError) || error.status !== 404) throw error;
      body = await this.json<unknown>(`/orgs/${encodeURIComponent(owner)}/packages${query}`);
    }
    return (Array.isArray(body) ? body : []).map((entry) => {
      const value = record(entry);
      return {
        name: text(value.name),
        type: text(value.package_type),
        version: "",
        createdAt: text(value.created_at),
        htmlUrl: text(value.html_url),
      };
    });
  }

  async gitTree(repo: ForgeRepoRef, ref: string, recursive = true): Promise<ForgeTree> {
    const query = recursive ? "?recursive=1" : "";
    return this.mapTree(await this.json<unknown>(`${this.repoPath(repo)}/git/trees/${encodeURIComponent(ref)}${query}`));
  }
}

// ── Gitea ────────────────────────────────────────────────────────────────────

class GiteaForgeClient extends BaseForgeClient {
  async whoami(): Promise<ForgeIdentity> {
    const [user, version] = await Promise.all([
      this.json<unknown>("/user"),
      // /version is public; a server that hides it is still usable.
      this.json<unknown>("/version").catch(() => null),
    ]);
    const account = record(user);
    return {
      login: text(account.login),
      name: text(account.full_name) || undefined,
      serverVersion: text(record(version).version) || null,
    };
  }

  async repoView(repo: ForgeRepoRef): Promise<ForgeRepoSummary> {
    const value = record(await this.json<unknown>(this.repoPath(repo)));
    return {
      fullName: text(value.full_name),
      description: text(value.description),
      defaultBranch: text(value.default_branch),
      private: value.private === true,
      archived: value.archived === true,
      fork: value.fork === true,
      // Gitea names the star count `stars_count` and has no `pushed_at`.
      stars: count(value.stars_count),
      openIssues: count(value.open_issues_count),
      updatedAt: text(value.updated_at),
      htmlUrl: text(value.html_url),
      cloneUrl: text(value.clone_url),
    };
  }

  async issues(repo: ForgeRepoRef, options: ForgeListOptions = {}): Promise<ForgeIssueSummary[]> {
    const query = this.query({ state: options.state ?? "open", limit: options.limit ?? 30, type: "issues" });
    const body = await this.json<unknown[]>(`${this.repoPath(repo)}/issues${query}`);
    return (Array.isArray(body) ? body : []).map((entry) => this.mapIssue(entry));
  }

  async pulls(repo: ForgeRepoRef, options: ForgeListOptions = {}): Promise<ForgePullSummary[]> {
    const query = this.query({ state: options.state ?? "open", limit: options.limit ?? 30 });
    const body = await this.json<unknown[]>(`${this.repoPath(repo)}/pulls${query}`);
    return (Array.isArray(body) ? body : []).map((entry) => this.mapPull(entry));
  }

  async pullDiff(repo: ForgeRepoRef, index: number): Promise<string> {
    return this.plain(`${this.repoPath(repo)}/pulls/${index}.diff`);
  }

  async releases(repo: ForgeRepoRef, limit = 20): Promise<ForgeRelease[]> {
    const body = await this.json<unknown[]>(`${this.repoPath(repo)}/releases${this.query({ limit })}`);
    return (Array.isArray(body) ? body : []).map((entry) => this.mapRelease(entry));
  }

  /** Gitea takes the asset as multipart form data on the API origin itself,
   * in a field literally named `attachment`. */
  async releaseUpload(repo: ForgeRepoRef, releaseId: number, file: Blob, fileName: string): Promise<ForgeReleaseAsset> {
    const form = new FormData();
    form.append("attachment", file, fileName);
    const url = `${this.apiUrl}${this.repoPath(repo)}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`;
    const response = await this.send(url, { method: "POST", body: form });
    const asset = record(await response.json());
    return {
      id: count(asset.id),
      name: text(asset.name),
      size: count(asset.size),
      downloadUrl: text(asset.browser_download_url),
    };
  }

  async runs(repo: ForgeRepoRef, options: ForgeRunListOptions = {}): Promise<ForgeRun[]> {
    const query = this.query({
      limit: options.limit ?? 20,
      branch: options.branch,
      event: options.event,
      status: options.status,
    });
    const body = record(await this.json<unknown>(`${this.repoPath(repo)}/actions/runs${query}`));
    const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
    return runs.map((entry) => this.mapRun(entry));
  }

  async packages(owner: string, limit = 30): Promise<ForgePackage[]> {
    const query = this.query({ type: "container", limit });
    const body = await this.json<unknown[]>(`/packages/${encodeURIComponent(owner)}${query}`);
    return (Array.isArray(body) ? body : []).map((entry) => {
      const value = record(entry);
      return {
        name: text(value.name),
        type: text(value.type),
        version: text(value.version),
        createdAt: text(value.created_at),
        htmlUrl: text(value.html_url),
      };
    });
  }

  async gitTree(repo: ForgeRepoRef, ref: string, recursive = true): Promise<ForgeTree> {
    const query = recursive ? "?recursive=true&per_page=1000" : "";
    return this.mapTree(await this.json<unknown>(`${this.repoPath(repo)}/git/trees/${encodeURIComponent(ref)}${query}`));
  }
}

export function createForgeClient(host: ForgeHost, options?: ForgeClientOptions): ForgeClient {
  return host.kind === "gitea" ? new GiteaForgeClient(host, options) : new GitHubForgeClient(host, options);
}

/** A file on disk as an upload body, so `release_upload` takes a path rather
 * than asking the agent to base64 a build artifact into a tool call. */
export async function fileAsBlob(filePath: string): Promise<{ blob: Blob; name: string }> {
  const bytes = await readFile(filePath);
  return { blob: new Blob([new Uint8Array(bytes)]), name: basename(filePath) };
}
