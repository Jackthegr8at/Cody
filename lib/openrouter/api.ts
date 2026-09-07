/**
 * OpenRouter's account API, normalized into Cody's vocabulary.
 *
 * Why this exists: OpenRouter is a GATEWAY, and that breaks the assumption the
 * quota meter was built on. Every other provider Cody reads usage for sells a
 * SUBSCRIPTION — a rolling window that refills on a clock, which is what
 * `UsageWindow` describes. OpenRouter sells a PREPAID BALANCE: it does not
 * refill, it runs out, and "72% of your 5-hour window" is not a sentence that
 * can be said about it. Forcing it into `UsageWindow` would either invent a
 * reset time that never comes or paint a percentage of a number the user can
 * change by buying more, so credits get their own shape and their own section.
 *
 * What the API actually permits, established by probing it rather than by
 * reading the docs (2026-09, key `sk-or-v1-…`):
 *
 *   GET /credits   → {total_credits, total_usage}      inference key ✓
 *   GET /key       → usage + limit + tier + expiry     inference key ✓
 *   GET /providers → 106 provider slugs                inference key ✓
 *   GET /activity  → per-day rows            MANAGEMENT key (403 otherwise)
 *   GET /keys      → key roster + caps       MANAGEMENT key (401 otherwise)
 *   POST /credits/coinbase → 410 GONE. Programmatic top-up was REMOVED
 *     upstream (Coinbase deprecated the APIs it used); the docs now say to
 *     "use the web credits purchase flow". There is no replacement endpoint —
 *     /credits/purchase, /credits/topup, /payments/checkout are all 404. So
 *     Cody cannot buy credits, and anything here that claimed to would be a
 *     lie. `TOPUP_URL` is the honest surface: a deep link, plus a balance
 *     read afterwards to confirm the money landed.
 *
 * Everything is a plain typed read with a timeout and a defensive parse: the
 * bodies are third-party JSON, so a missing or malformed field degrades to
 * `null` rather than throwing into a route that renders a meter.
 */
import { isRecord, asNumber, asString } from "../type-guards";

const API_ROOT = "https://openrouter.ai/api/v1";

/** The page that actually sells credits. The ONLY top-up path that exists. */
export const TOPUP_URL = "https://openrouter.ai/settings/credits";
/** Where a management key is minted, for the hint on the settings field. */
export const PROVISIONING_KEYS_URL = "https://openrouter.ai/settings/provisioning-keys";

/** Third-party HTTP: never let a hung gateway hold a route open. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Prepaid balance. `remaining` is the number that matters — it is what runs
 * out mid-turn — but it is DERIVED, because OpenRouter reports the two totals
 * and not the difference. Clamped at zero: a negative balance is not a
 * quantity a user can act on, and `-0.03 credits left` reads as a bug. */
export interface OpenRouterCredits {
  totalCredits: number;
  totalUsage: number;
  remaining: number;
}

/** The key's own spend, and the cap on it if one is set. Distinct from the
 * account balance: a key can be capped far below the credits available. */
export interface OpenRouterKeyInfo {
  /** Masked label OpenRouter itself prints (`sk-or-v1-15f...879`). Never the key. */
  label: string | null;
  usage: number | null;
  usageDaily: number | null;
  usageWeekly: number | null;
  usageMonthly: number | null;
  /** Spend cap on THIS key, or null when uncapped. */
  limit: number | null;
  /** Cap minus spend, as OpenRouter computes it; null when uncapped. */
  limitRemaining: number | null;
  freeTier: boolean;
  /** ISO expiry, when the key is time-boxed. */
  expiresAt: string | null;
  isManagementKey: boolean;
}

/** One day of spend, from the management-key-only activity endpoint. */
export interface OpenRouterActivityDay {
  date: string;
  usage: number;
  requests: number;
}

/** A key in the account's roster (management key only). */
export interface OpenRouterManagedKey {
  hash: string;
  name: string;
  label: string | null;
  disabled: boolean;
  limit: number | null;
  usage: number | null;
  createdAt: string | null;
}

/** Why a read produced nothing. `management_key_required` is the one the UI
 * turns into an offer ("add a management key to see daily spend") rather than
 * an error — it means the call was well-formed and the account simply has not
 * granted Cody that scope. */
export type OpenRouterErrorCode =
  | "no_key"
  | "unauthorized"
  | "management_key_required"
  | "rate_limited"
  | "unreachable"
  | "bad_response";

export interface OpenRouterError {
  code: OpenRouterErrorCode;
  message: string;
}

export type OpenRouterResult<T> = { ok: true; value: T } | { ok: false; error: OpenRouterError };

function fail<T>(code: OpenRouterErrorCode, message: string): OpenRouterResult<T> {
  return { ok: false, error: { code, message } };
}

/**
 * Map a transport/HTTP outcome onto Cody's codes. The 401-vs-403 split is
 * load-bearing and NOT interchangeable: OpenRouter answers 403 "Only
 * management keys can fetch activity" when a valid inference key asks for
 * activity, but 401 "Invalid API key" when that same key asks for /keys. Both
 * mean "you need a management key for this", so a scope-gated endpoint maps
 * BOTH to `management_key_required` — reporting 401 as `unauthorized` there
 * would tell the user their working key is invalid.
 */
function classify(status: number, body: string, scopeGated: boolean): OpenRouterError {
  const upstream = extractMessage(body);
  if (status === 401 || status === 403) {
    if (scopeGated) {
      return { code: "management_key_required", message: upstream ?? "This read needs an OpenRouter management key." };
    }
    return { code: "unauthorized", message: upstream ?? "OpenRouter rejected the API key." };
  }
  if (status === 429) return { code: "rate_limited", message: upstream ?? "OpenRouter is rate-limiting this key." };
  return { code: "bad_response", message: upstream ?? `OpenRouter answered HTTP ${status}.` };
}

/** OpenRouter's error envelope is `{error:{message,code}}`; a 404 on an
 * unknown path can also be its Next.js HTML page, which must never be shown. */
function extractMessage(body: string): string | null {
  if (!body || body.startsWith("<")) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed.error)) return asString(parsed.error.message) ?? null;
  } catch { /* Not JSON: fall through to the generic message. */ }
  return null;
}

async function get<T>(
  path: string,
  key: string,
  parse: (data: unknown) => T | null,
  options: { scopeGated?: boolean; fetcher?: typeof fetch } = {},
): Promise<OpenRouterResult<T>> {
  if (!key) return fail("no_key", "No OpenRouter API key is configured.");
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  let body: string;
  try {
    response = await fetcher(`${API_ROOT}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = await response.text();
  } catch (error) {
    return fail("unreachable", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) return { ok: false, error: classify(response.status, body, options.scopeGated === true) };
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return fail("bad_response", "OpenRouter returned a body that is not JSON.");
  }
  // Every account endpoint wraps its payload in `{data: …}`.
  const parsed = parse(isRecord(payload) ? payload.data : undefined);
  if (parsed === null) return fail("bad_response", "OpenRouter returned an unexpected shape.");
  return { ok: true, value: parsed };
}

function parseCredits(data: unknown): OpenRouterCredits | null {
  if (!isRecord(data)) return null;
  const totalCredits = asNumber(data.total_credits);
  const totalUsage = asNumber(data.total_usage);
  if (totalCredits === undefined || totalUsage === undefined) return null;
  return { totalCredits, totalUsage, remaining: Math.max(0, totalCredits - totalUsage) };
}

function parseKeyInfo(data: unknown): OpenRouterKeyInfo | null {
  if (!isRecord(data)) return null;
  return {
    label: asString(data.label) ?? null,
    usage: asNumber(data.usage) ?? null,
    usageDaily: asNumber(data.usage_daily) ?? null,
    usageWeekly: asNumber(data.usage_weekly) ?? null,
    usageMonthly: asNumber(data.usage_monthly) ?? null,
    limit: asNumber(data.limit) ?? null,
    limitRemaining: asNumber(data.limit_remaining) ?? null,
    freeTier: data.is_free_tier === true,
    expiresAt: asString(data.expires_at) ?? null,
    // Either flag makes the key privileged; OpenRouter reports both.
    isManagementKey: data.is_management_key === true || data.is_provisioning_key === true,
  };
}

function parseActivity(data: unknown): OpenRouterActivityDay[] | null {
  if (!Array.isArray(data)) return null;
  const days: OpenRouterActivityDay[] = [];
  for (const row of data) {
    if (!isRecord(row)) continue;
    const date = asString(row.date);
    if (!date) continue;
    days.push({
      date,
      usage: asNumber(row.usage) ?? 0,
      requests: asNumber(row.requests) ?? 0,
    });
  }
  // Newest last, so a sparkline reads left-to-right in time order.
  days.sort((a, b) => a.date.localeCompare(b.date));
  return days;
}

function parseManagedKeys(data: unknown): OpenRouterManagedKey[] | null {
  if (!Array.isArray(data)) return null;
  const keys: OpenRouterManagedKey[] = [];
  for (const row of data) {
    if (!isRecord(row)) continue;
    const hash = asString(row.hash);
    if (!hash) continue;
    keys.push({
      hash,
      name: asString(row.name) ?? "Untitled key",
      label: asString(row.label) ?? null,
      disabled: row.disabled === true,
      limit: asNumber(row.limit) ?? null,
      usage: asNumber(row.usage) ?? null,
      createdAt: asString(row.created_at) ?? null,
    });
  }
  return keys;
}

export interface OpenRouterFetchOptions {
  fetcher?: typeof fetch;
}

export function fetchCredits(key: string, options: OpenRouterFetchOptions = {}): Promise<OpenRouterResult<OpenRouterCredits>> {
  return get("/credits", key, parseCredits, options);
}

export function fetchKeyInfo(key: string, options: OpenRouterFetchOptions = {}): Promise<OpenRouterResult<OpenRouterKeyInfo>> {
  return get("/key", key, parseKeyInfo, options);
}

/** Management key only — a plain inference key answers 403 here. */
export function fetchActivity(key: string, options: OpenRouterFetchOptions = {}): Promise<OpenRouterResult<OpenRouterActivityDay[]>> {
  return get("/activity", key, parseActivity, { ...options, scopeGated: true });
}

/** Management key only — a plain inference key answers 401 here. */
export function fetchManagedKeys(key: string, options: OpenRouterFetchOptions = {}): Promise<OpenRouterResult<OpenRouterManagedKey[]>> {
  return get("/keys", key, parseManagedKeys, { ...options, scopeGated: true });
}

/**
 * Set or clear the spend cap on one key (management key only).
 *
 * This is the one genuinely useful WRITE the API still offers, and the reason
 * a management key is worth adding at all: it is how "cap this key at $20"
 * happens without leaving Cody. `limit: null` removes the cap.
 */
export async function updateKeyLimit(
  managementKey: string,
  hash: string,
  limit: number | null,
  options: OpenRouterFetchOptions = {},
): Promise<OpenRouterResult<OpenRouterManagedKey>> {
  if (!managementKey) return fail("no_key", "No OpenRouter management key is configured.");
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  let body: string;
  try {
    response = await fetcher(`${API_ROOT}/keys/${encodeURIComponent(hash)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${managementKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ limit }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = await response.text();
  } catch (error) {
    return fail("unreachable", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) return { ok: false, error: classify(response.status, body, true) };
  try {
    const payload: unknown = JSON.parse(body);
    const parsed = parseManagedKeys([isRecord(payload) ? payload.data : undefined]);
    if (parsed && parsed.length === 1) return { ok: true, value: parsed[0] };
  } catch { /* Fall through to the shape error. */ }
  return fail("bad_response", "OpenRouter returned an unexpected shape.");
}
