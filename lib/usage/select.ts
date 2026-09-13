import type { UsageAccount, UsageAccountService, UsageWindow } from "./types";

/**
 * Picking the binding constraint.
 *
 * An account can report half a dozen overlapping windows and the user only
 * cares about the one that will actually stop them next. Exhaustion first — a
 * refused window stops the model now, whatever its term — then the shortest
 * span: the current 5 hours are what this turn spends against, and a fuller
 * week is context, not the gauge. Only then the fullest window, then the one
 * that clears soonest — a window with no known reset is the least useful
 * answer, so it loses every tie.
 */

export function selectBindingWindow(
  accounts: UsageAccount[],
): { account: UsageAccount; window: UsageWindow } | null {
  let best: { account: UsageAccount; window: UsageWindow } | null = null;
  for (const account of accounts ?? []) {
    for (const window of account?.windows ?? []) {
      if (!window) continue;
      if (best === null || isMoreBinding(window, best.window)) best = { account, window };
    }
  }
  return best;
}

/** One model the user can have selected, in the shape the model list reports. */
export interface ModelRef {
  provider: string;
  modelId: string;
}

/** One ranked account for a provider, alongside the windows that actually
 * constrain the given model and the single window binding it, if any. */
export interface ProviderAccountRank {
  account: UsageAccount;
  /** This account's windows that constrain the given model, most binding first. */
  windows: UsageWindow[];
  state: UsageAccountService;
  /** windows[0], or null when the account has nothing applicable. */
  binding: UsageWindow | null;
}

/**
 * Ranking every account serving one provider by the state omp itself would
 * assign it right now: whichever account is actually taking this provider's
 * traffic ("serving"), any healthy siblings held in reserve ("standby"), any
 * account whose binding window is spent ("limited"), and any credential the
 * engine disabled outright ("disabled") — always last, regardless of usage.
 *
 * Gauging the tightest account across a provider's siblings is the wrong
 * read: omp rotates the same model onto another credential the moment one is
 * rate-limited, so a gauge built on the exhausted sibling is reporting quota
 * nothing is being charged against anymore. This ranks by the account omp
 * would actually route to next, mirroring its own credential-ranking order.
 *
 * Precedence, most to least preferred: a **measured** account (a real window
 * applies to this model) ordered by ascending binding utilization, then an
 * **unmeasured** one (nothing applies — not limited, but not evidence of
 * anything either, so it never outranks a sibling with real telemetry), then
 * **limited** (earliest reset first), then **disabled**.
 *
 * `modelId` scopes which windows count as each account's binding window, same
 * as `selectWindowsForModel` below; omit it (or pass `""`) to rank by
 * provider-level (untiered) windows only.
 */
export function rankProviderAccounts(
  accounts: UsageAccount[],
  provider: string,
  modelId?: string,
): ProviderAccountRank[] {
  const normalizedProvider = normalize(provider);
  if (!normalizedProvider) return [];
  const scopeModelId = typeof modelId === "string" ? modelId : "";

  const entries = (accounts ?? [])
    .filter(
      (account): account is UsageAccount => Boolean(account) && normalize(account.provider) === normalizedProvider,
    )
    .map((account, index) => {
      const windows = (account.windows ?? [])
        .filter((window): window is UsageWindow => Boolean(window) && windowConstrainsModel(window, scopeModelId))
        .sort(compareBinding);
      return { account, windows, binding: windows[0] ?? null, index };
    });

  // Disabled always sorts last, whatever it reports; a live rank never has
  // windows to weigh it against anyway (omp-usage.ts gives it windows: []).
  const disabled = entries.filter((entry) => Boolean(entry.account.disabled));
  const live = entries.filter((entry) => !entry.account.disabled);
  const limited = live.filter((entry) => entry.binding?.state === "exhausted");
  const measured = live.filter((entry) => entry.binding !== null && entry.binding.state !== "exhausted");
  // An account with nothing applicable to this model is not limited — no
  // reported window means no reported constraint — but it is also not
  // evidence of anything, so real telemetry on a sibling always outranks a
  // guess: it sorts after every measured account, ahead only of accounts omp
  // has actually cut off.
  const unmeasured = live.filter((entry) => entry.binding === null);

  measured.sort((a, b) => {
    const utilA = toUtilization(a.binding!.utilization);
    const utilB = toUtilization(b.binding!.utilization);
    return utilA !== utilB ? utilA - utilB : a.index - b.index;
  });
  unmeasured.sort((a, b) => a.index - b.index);
  limited.sort((a, b) => {
    const resetA = toResetTime(a.binding?.resetsAt ?? null);
    const resetB = toResetTime(b.binding?.resetsAt ?? null);
    return resetA !== resetB ? resetA - resetB : a.index - b.index;
  });

  const ranked: ProviderAccountRank[] = [];
  for (const { account, windows, binding } of [...measured, ...unmeasured]) {
    ranked.push({ account, windows, binding, state: ranked.length === 0 ? "serving" : "standby" });
  }
  for (const { account, windows, binding } of limited) ranked.push({ account, windows, binding, state: "limited" });
  for (const { account, windows, binding } of disabled) ranked.push({ account, windows, binding, state: "disabled" });
  return ranked;
}

/**
 * The windows that actually constrain one model, most binding first, read off
 * the account omp is actually serving this model from right now.
 *
 * Quota is per provider, so a model is only ever limited by the account that
 * serves it: a spent quota on another provider says nothing about whether
 * this model can run. No account for the provider means no answer at all
 * (null) — the caller must say "no quota reported" rather than borrow another
 * provider's numbers.
 *
 * A provider can have more than one account; the exhausted-but-idle sibling
 * is not the honest gauge, because omp already rotated the model onto
 * whichever account `rankProviderAccounts` ranks first ("serving"). This
 * returns that account's windows, keeping every window-picking caller in
 * sync with the engine instead of naming whichever sibling is tightest.
 *
 * Returns a matched account with an empty `windows` list when the provider
 * reports quota but none of it applies to this model.
 */
export function selectWindowsForModel(
  accounts: UsageAccount[],
  model: ModelRef | null | undefined,
): { account: UsageAccount; windows: UsageWindow[] } | null {
  const provider = normalize(model?.provider);
  if (!provider) return null;
  const modelId = typeof model?.modelId === "string" ? model.modelId : "";
  const top = rankProviderAccounts(accounts, provider, modelId)[0];
  return top ? { account: top.account, windows: top.windows } : null;
}

/** The one window that will stop this model next, or null when none applies. */
export function selectBindingWindowForModel(
  accounts: UsageAccount[],
  model: ModelRef | null | undefined,
): { account: UsageAccount; window: UsageWindow } | null {
  const match = selectWindowsForModel(accounts, model);
  const window = match?.windows[0];
  return match && window ? { account: match.account, window } : null;
}

/**
 * Whether a tier-scoped window covers a given model.
 *
 * The tier has to appear in the model id as a whole token — delimited by
 * non-alphanumerics or the ends of the string — so "opus" matches
 * "claude-opus-4-5" but not "claude-opusx". Substring matching would quietly
 * charge one model's quota against an unrelated model whose name happens to
 * contain the tier.
 */
export function modelMatchesTier(modelId: string, tier: string): boolean {
  const haystack = normalize(modelId);
  const needle = normalize(tier);
  if (!haystack || !needle) return false;

  for (let from = 0; ; from = from + 1) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    if (!isAlphanumericAt(haystack, at - 1) && !isAlphanumericAt(haystack, at + needle.length)) return true;
    from = at;
  }
}

/**
 * A reported tier always scopes a window to its own models. OMP can mark a
 * tiered bucket shared too, so that flag must not erase the explicit scope and
 * charge it to another model. Untiered windows bind the whole account.
 */
function windowConstrainsModel(window: UsageWindow, modelId: string): boolean {
  const tier = typeof window.tier === "string" ? window.tier.trim() : "";
  return !tier || modelMatchesTier(modelId, tier);
}

function isMoreBinding(candidate: UsageWindow, incumbent: UsageWindow): boolean {
  return compareBinding(candidate, incumbent) < 0;
}

/** Sort comparator for the ranking above: most binding first, ties left in the
 * order encountered so the ring and the popover always name the same window. */
function compareBinding(a: UsageWindow, b: UsageWindow): number {
  // Only exhaustion outranks the term. A warning refuses nothing, so it must
  // not drag the gauge off the short window the turn is actually spending.
  const refusedA = a.state === "exhausted" ? 1 : 0;
  const refusedB = b.state === "exhausted" ? 1 : 0;
  if (refusedA !== refusedB) return refusedB - refusedA;

  const spanA = toWindowSpan(a.windowMs);
  const spanB = toWindowSpan(b.windowMs);
  if (spanA !== spanB) return spanA - spanB;

  const usedA = toUtilization(a.utilization);
  const usedB = toUtilization(b.utilization);
  if (usedA !== usedB) return usedB - usedA;

  const resetA = toResetTime(a.resetsAt);
  const resetB = toResetTime(b.resetsAt);
  if (resetA !== resetB) return resetA - resetB;

  // Fully tied: the first window encountered keeps the slot, so repeated calls
  // over the same snapshot always name the same window.
  return 0;
}

/** Unknown spans sort last: a window that will not say how long it lasts
 * cannot claim to be the near-term one. */
function toWindowSpan(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : Number.POSITIVE_INFINITY;
}

function toUtilization(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Missing or unparseable resets sort last. */
function toResetTime(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

function normalize(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isAlphanumericAt(value: string, index: number): boolean {
  if (index < 0 || index >= value.length) return false;
  const code = value.charCodeAt(index);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}
