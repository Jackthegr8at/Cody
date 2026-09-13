import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { stringify } from "yaml";
import { getPromptProfile, selectPromptProfileId } from "./local-model-profile";
import { isConfirmedLocalEndpoint } from "./local-model-profile-runtime";
import { getAgentDir } from "./omp/paths";
import { readModelsConfigFile } from "./omp/models-config";
import { getOmpModelRoleIds, readModelRoles } from "./omp/model-roles";
import { readNativeSettings } from "./omp/settings-config";
import { isRecord } from "./type-guards";
import {
  localModelKey,
  MAX_LOCAL_ROUTING_FALLBACKS,
  resolveLocalRoutingIntent,
  validateLocalRoutingConfig,
  type LocalModelReference,
  type LocalRoutingCandidate,
  type LocalRoutingConfig,
  type LocalRoutingEnvelope,
  type LocalRoutingIntent,
} from "./local-model-routing-policy";

export type {
  LocalModelReference,
  LocalRoutingCandidate,
  LocalRoutingConfig,
  LocalRoutingEnvelope,
  LocalRoutingIntent,
} from "./local-model-routing-policy";

/** Cody-owned state. It is deliberately never written to omp's config.yml. */
export const LOCAL_ROUTING_CONFIG_FILE = "cody-local-routing.json";
const LOCAL_ROUTING_SESSIONS_FILE = "cody-local-routing-sessions.json";
const OVERLAY_DIRECTORY = "cody-local-routing";
const VERSION = 1;

interface StoredRoutingConfig extends LocalRoutingConfig {
  version: number;
  [extra: string]: unknown;
}

interface StoredSessionRouting {
  version: number;
  /** A validated config snapshot: global edits apply to future Local-only sessions only. */
  sessions: Record<string, LocalRoutingConfig | null>;
}

export interface LocalRoutingModel extends LocalRoutingCandidate {
  name: string;
  inputBudget: number;
  profileId: "full" | "compact" | "minimal";
  /** `null` means the engine-default toolset; an array is the reduced active profile. */
  toolNames: string[] | null;
}

export interface LocalRoutingAvailability {
  models: LocalRoutingModel[];
  error?: string;
}

export interface LocalRoutingLaunch {
  /** The one-time overlay path. Runtime appends it after profile overlays. */
  overlayPath: string;
  env: Record<string, string>;
  overlayIdentity: {
    roles: Record<string, string>;
    fallbackChains: Record<string, string[]>;
    enabledModels: string[];
    envelope: LocalRoutingEnvelope;
  };
}

const EMPTY_CONFIG: LocalRoutingConfig = { primary: null, fallbacks: [], roles: {} };

function configPath(): string {
  return path.join(getAgentDir(), LOCAL_ROUTING_CONFIG_FILE);
}

function sessionsPath(): string {
  return path.join(getAgentDir(), LOCAL_ROUTING_SESSIONS_FILE);
}

function atomicJsonWrite(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function copyReference(value: LocalModelReference): LocalModelReference {
  return { provider: value.provider, modelId: value.modelId };
}

function readReference(value: unknown): LocalModelReference | null {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.modelId !== "string") return null;
  if (!value.provider || !value.modelId || value.provider.trim() !== value.provider || value.modelId.trim() !== value.modelId) return null;
  if (value.provider.length > 200 || value.modelId.length > 200 || /[\s\r\n]/.test(value.provider) || /[\s\r\n]/.test(value.modelId)) return null;
  return { provider: value.provider, modelId: value.modelId };
}

function copyRoutingConfig(value: LocalRoutingConfig): LocalRoutingConfig {
  return {
    primary: value.primary ? copyReference(value.primary) : null,
    fallbacks: value.fallbacks.map(copyReference),
    roles: Object.fromEntries(Object.entries(value.roles).map(([role, target]) => [role, target ? copyReference(target) : null])),
  };
}

function readStoredRoutingConfig(value: unknown): LocalRoutingConfig | null {
  if (!isRecord(value)) return null;
  const primary = readReference(value.primary);
  if (!primary || !Array.isArray(value.fallbacks) || value.fallbacks.length > MAX_LOCAL_ROUTING_FALLBACKS || !isRecord(value.roles)) return null;
  const fallbacks: LocalModelReference[] = [];
  for (const fallback of value.fallbacks) {
    const reference = readReference(fallback);
    if (!reference) return null;
    fallbacks.push(reference);
  }
  const roles: Record<string, LocalModelReference | null> = {};
  for (const [role, target] of Object.entries(value.roles)) {
    if (!role || role.length > 200 || /[\s\r\n]/.test(role)) return null;
    if (target === null) {
      roles[role] = null;
      continue;
    }
    const reference = readReference(target);
    if (!reference) return null;
    roles[role] = reference;
  }
  return { primary, fallbacks, roles };
}

function readConfigFile(): StoredRoutingConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return { version: VERSION, ...EMPTY_CONFIG };
  }
  if (!isRecord(parsed)) return { version: VERSION, ...EMPTY_CONFIG };
  const primary = readReference(parsed.primary);
  const fallbacks = Array.isArray(parsed.fallbacks)
    ? parsed.fallbacks.flatMap((value) => {
      const reference = readReference(value);
      return reference ? [reference] : [];
    }).slice(0, 8)
    : [];
  const roles: Record<string, LocalModelReference | null> = {};
  if (isRecord(parsed.roles)) {
    for (const [role, value] of Object.entries(parsed.roles)) {
      if (!role || role.length > 200) continue;
      const reference = value === null ? null : readReference(value);
      if (reference !== null || value === null) roles[role] = reference;
    }
  }
  return { ...parsed, version: VERSION, primary, fallbacks, roles };
}

/** The durable instance configuration, copied so callers cannot mutate a cache. */
export function readLocalRoutingConfig(): LocalRoutingConfig {
  const stored = readConfigFile();
  return {
    primary: stored.primary ? copyReference(stored.primary) : null,
    fallbacks: stored.fallbacks.map(copyReference),
    roles: Object.fromEntries(Object.entries(stored.roles).map(([role, value]) => [role, value ? copyReference(value) : null])),
  };
}

/**
 * Candidates are proven by the configured endpoint URL, never by names or
 * zero-price metadata. A valid output reservation is required so fallback
 * history can be bounded before a turn reaches a smaller destination.
 */
export function configuredLocalRoutingModels(): LocalRoutingAvailability {
  const file = readModelsConfigFile();
  if (file.parseError) return { models: [], error: `${file.path} is unreadable: ${file.parseError}` };

  const models: LocalRoutingModel[] = [];
  for (const [provider, providerConfig] of Object.entries(file.config.providers ?? {})) {
    for (const model of providerConfig.models ?? []) {
      if (!isConfirmedLocalEndpoint(model.baseUrl ?? providerConfig.baseUrl)) continue;
      if (!model.id || typeof model.contextWindow !== "number" || typeof model.maxTokens !== "number") continue;
      const contextWindow = model.contextWindow;
      const maxTokens = model.maxTokens;
      if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens) || contextWindow <= maxTokens || maxTokens <= 0) continue;
      const profileId = selectPromptProfileId({ contextWindow });
      const profile = getPromptProfile(profileId, contextWindow, maxTokens);
      models.push({
        provider,
        modelId: model.id,
        name: model.name || model.id,
        contextWindow,
        maxTokens,
        inputBudget: contextWindow - maxTokens,
        profileId,
        toolNames: profile.toolNames ? [...profile.toolNames] : null,
      });
    }
  }
  models.sort((left, right) => left.name.localeCompare(right.name) || left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId));
  return models.length > 0
    ? { models }
    : { models, error: "No configured usable local model is available. Local-only will not fall back to cloud models." };
}

/** Installed engine role vocabulary; the engine owns this list. */
export function localRoutingRoleIds(): readonly string[] {
  return getOmpModelRoleIds();
}

function candidatePolicyModels(): { candidates: LocalRoutingCandidate[]; roleIds: readonly string[]; error?: string } {
  const availability = configuredLocalRoutingModels();
  return { candidates: availability.models, roleIds: localRoutingRoleIds(), error: availability.error };
}

/** Validate then atomically replace Local-only settings. Unknown future keys survive the write. */
export function writeLocalRoutingConfig(value: unknown): LocalRoutingConfig {
  const { candidates, roleIds, error } = candidatePolicyModels();
  if (error) throw new Error(error);
  const validated = validateLocalRoutingConfig(value, candidates, roleIds);
  if (!validated.ok) throw new Error(validated.error);
  const primary = validated.config.primary;
  if (!primary) throw new Error("Choose a configured local primary model; Local-only never falls back to cloud models.");

  const previous = readConfigFile();
  const next: StoredRoutingConfig = {
    ...previous,
    version: VERSION,
    primary: copyReference(primary),
    fallbacks: validated.config.fallbacks.map(copyReference),
    roles: Object.fromEntries(Object.entries(validated.config.roles).map(([role, target]) => [role, target ? copyReference(target) : null])),
  };
  atomicJsonWrite(configPath(), next);
  return readLocalRoutingConfig();
}

function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000\r\n]/.test(value);
}

function readSessionFile(): StoredSessionRouting {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sessionsPath(), "utf8"));
  } catch {
    return { version: VERSION, sessions: {} };
  }
  if (!isRecord(parsed) || !isRecord(parsed.sessions)) return { version: VERSION, sessions: {} };
  const sessions: Record<string, LocalRoutingConfig | null> = {};
  for (const [sessionId, value] of Object.entries(parsed.sessions)) {
    if (!validSessionId(sessionId)) continue;
    // Version-one flags lacked a snapshot. Keep them Local-only but fail closed
    // until the user explicitly reselects the mode.
    sessions[sessionId] = value === true ? null : readStoredRoutingConfig(value);
  }
  return { version: VERSION, sessions };
}

/** Is this session's durable routing intent Local-only? */
export function isSessionLocalOnly(sessionId: string | undefined): boolean {
  return !!sessionId && validSessionId(sessionId) && readSessionFile().sessions[sessionId] !== undefined;
}

function writeSessionFile(file: StoredSessionRouting): void {
  atomicJsonWrite(sessionsPath(), file);
}

/** Persist a Local-only flag only after its configured local route validates. */
export function setSessionLocalOnly(sessionId: string, enabled: boolean): LocalRoutingIntent {
  if (!validSessionId(sessionId)) throw new Error("Invalid session id.");
  if (enabled) {
    const intent = readConfiguredLocalRoutingIntent();
    if (!intent.enabled) throw new Error(intent.error ?? "No configured usable local model is available; no cloud fallback will be used.");
    const file = readSessionFile();
    file.sessions[sessionId] = copyRoutingConfig(readLocalRoutingConfig());
    writeSessionFile(file);
    return intent;
  }
  const file = readSessionFile();
  if (file.sessions[sessionId] !== undefined) {
    delete file.sessions[sessionId];
    writeSessionFile(file);
  }
  return { enabled: false };
}

/** Move the pre-spawn flag onto omp's real session id. */
export function renameSessionLocalRouting(fromSessionId: string, toSessionId: string): void {
  if (!validSessionId(fromSessionId) || !validSessionId(toSessionId) || fromSessionId === toSessionId) return;
  const file = readSessionFile();
  const snapshot = file.sessions[fromSessionId];
  if (snapshot === undefined) return;
  delete file.sessions[fromSessionId];
  file.sessions[toSessionId] = snapshot;
  writeSessionFile(file);
}

/** Copy a frozen Local-only snapshot when a fork leaves its parent resumable. */
export function copySessionLocalRouting(fromSessionId: string, toSessionId: string): void {
  if (!validSessionId(fromSessionId) || !validSessionId(toSessionId) || fromSessionId === toSessionId) return;
  const file = readSessionFile();
  const snapshot = file.sessions[fromSessionId];
  if (snapshot === undefined) return;
  file.sessions[toSessionId] = snapshot ? copyRoutingConfig(snapshot) : null;
  writeSessionFile(file);
}

/** Drop sidecar state when the corresponding session is deleted. */
export function forgetSessionLocalRouting(sessionId: string): void {
  if (!validSessionId(sessionId)) return;
  const file = readSessionFile();
  if (file.sessions[sessionId] === undefined) return;
  delete file.sessions[sessionId];
  writeSessionFile(file);
}

export function readConfiguredLocalRoutingIntent(): LocalRoutingIntent {
  const { candidates, roleIds, error } = candidatePolicyModels();
  if (error) return { enabled: false, error };
  return resolveLocalRoutingIntent(readLocalRoutingConfig(), candidates, roleIds);
}

/**
 * Runtime entry point. A missing session id is intentionally disabled: this
 * prevents global Local-only state from ever changing an unrelated session.
 */
export function readLocalRoutingIntent(sessionId?: string): LocalRoutingIntent {
  if (!sessionId || !validSessionId(sessionId)) return { enabled: false };
  const snapshot = readSessionFile().sessions[sessionId];
  if (snapshot === undefined) return { enabled: false };
  if (!snapshot) return { enabled: false, error: "Local-only routing for this session has no validated configuration snapshot." };
  const { candidates, roleIds, error } = candidatePolicyModels();
  if (error) return { enabled: false, error };
  return resolveLocalRoutingIntent(snapshot, candidates, roleIds);
}

export function validateLocalRoutingModelSelection(
  sessionId: string | undefined,
  provider: string,
  modelId: string,
): { allowed: true } | { allowed: false; reason: string } {
  if (!isSessionLocalOnly(sessionId)) return { allowed: true };
  const intent = readLocalRoutingIntent(sessionId);
  if (!intent.enabled || !intent.primary) {
    return { allowed: false, reason: intent.error ?? "Local-only routing is unavailable; no cloud fallback will be used." };
  }
  const allowedModels = [intent.primary, ...(intent.fallbackChain ?? []), ...Object.values(intent.roleModels ?? {})];
  if (allowedModels.some((model) => model.provider === provider && model.modelId === modelId)) return { allowed: true };
  return { allowed: false, reason: `Local-only sessions cannot select ${provider}/${modelId}.` };
}

function selector(reference: LocalModelReference): string {
  return localModelKey(reference);
}

/**
 * OMP resolves exact fallback-chain keys before provider wildcards and role
 * keys. Each local source therefore gets its own suffix of the user's ordered
 * chain; an empty suffix is an intentional stop, never an inherited default.
 */
function fallbackSuffix(
  source: LocalModelReference,
  primary: LocalModelReference,
  fallbacks: readonly LocalModelReference[],
): string[] {
  const sourceKey = selector(source);
  const ordered = [primary, ...fallbacks];
  const sourceIndex = ordered.findIndex((candidate) => selector(candidate) === sourceKey);
  const candidates = sourceIndex < 0 ? fallbacks : fallbacks.slice(sourceIndex);
  return candidates.map(selector).filter((candidate) => candidate !== sourceKey);
}

/**
 * Materialize the launch-only omp overlay. It narrows enabledModels, fills every
 * installed role, and supplies each role's ordered retry fallbacks; no cloud
 * role/default/fallback can leak through this session's process.
 */
export function materializeLocalRoutingOverlay(intent: LocalRoutingIntent): LocalRoutingLaunch | null {
  if (!intent.enabled || !intent.primary || !intent.envelope || !intent.roleModels) return null;
  const roleEntries = Object.entries(intent.roleModels);
  if (roleEntries.length === 0) return null;

  const roles = Object.fromEntries(roleEntries.map(([role, model]) => [role, selector(model)]));
  const inheritedRoleTombstones = Object.fromEntries(Object.keys(readModelRoles().roles).map((role) => [role, null]));
  const inheritedChains = readNativeSettings().settings.retry?.fallbackChains ?? {};
  const inheritedChainTombstones = Object.fromEntries(Object.keys(inheritedChains).map((chain) => [chain, null]));
  const enabledModels = [...new Set([
    selector(intent.primary),
    ...(intent.fallbackChain ?? []).map(selector),
    ...roleEntries.map(([, model]) => selector(model)),
  ])];
  // Exact selectors outrank provider wildcards and role chains. Their values
  // are ordered suffixes, rather than a permutation of enabled models: a
  // fallback cannot loop backwards or gain an unconfigured destination.
  const fallbackChains: Record<string, string[]> = {};
  for (const model of enabledModels) {
    const [provider, ...modelId] = model.split("/");
    fallbackChains[model] = fallbackSuffix({ provider, modelId: modelId.join("/") }, intent.primary, intent.fallbackChain ?? []);
  }
  for (const [role, model] of roleEntries) {
    fallbackChains[role] = fallbackSuffix(model, intent.primary, intent.fallbackChain ?? []);
  }
  const overlayIdentity = { roles, fallbackChains, enabledModels, envelope: intent.envelope };
  const digest = createHash("sha256").update(JSON.stringify({
    version: VERSION,
    ...overlayIdentity,
    inheritedRoleKeys: Object.keys(inheritedRoleTombstones),
    inheritedChainKeys: Object.keys(inheritedChainTombstones),
  })).digest("hex");
  const directory = path.join(getAgentDir(), OVERLAY_DIRECTORY);
  const overlayPath = path.join(directory, `${digest}.yml`);
  if (!existsSync(overlayPath)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${overlayPath}.${randomBytes(6).toString("hex")}.tmp`;
    // OMP deep-merges config records. A null value at each inherited key is
    // a supported per-selector tombstone: its role/chain is no longer valid,
    // while the local values below replace their matching keys.
    writeFileSync(temporary, stringify({
      enabledModels,
      modelRoles: { ...inheritedRoleTombstones, ...roles },
      retry: { enabled: true, modelFallback: true, fallbackChains: { ...inheritedChainTombstones, ...fallbackChains } },
    }), { mode: 0o600 });
    try {
      renameSync(temporary, overlayPath);
    } catch (error) {
      if (!existsSync(overlayPath)) throw error;
    }
  }
  return { overlayPath, env: { PI_CONFIG_FILES: overlayPath }, overlayIdentity };
}
