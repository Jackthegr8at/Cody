/**
 * Turning quota telemetry into durable "do not route here" facts, and
 * folding those facts back into the snapshot every surface reads.
 *
 * `deriveBlackouts` is the observation step: an account is blacked out when
 * it reports an exhausted window that binds EVERY model it serves (an
 * untiered window). A tier-scoped exhaustion is not a blackout — the other
 * tiers still work, and live availability already scopes it correctly.
 *
 * `applyBlackouts` is the memory step: it re-asserts remembered exhaustion
 * on top of a fresh snapshot. That is what makes the rule hold when
 * telemetry goes quiet — a failed `omp usage` read reports nothing, and
 * "nothing" would otherwise read as "healthy" and send the next turn
 * straight back into a provider that is out for another six days.
 */

import type { OpenRouterAccountSnapshot } from "../openrouter/account";
import type { UsageAccount, UsageSnapshot, UsageWindow } from "../usage/types";
import { blackoutActive, type ProviderBlackout, type RouteMemory } from "./route-memory";

/** Provider id of the gateway whose balance is money, not a quota window. */
const OPENROUTER_PROVIDER = "openrouter";

function untieredExhausted(account: UsageAccount): UsageWindow[] {
	return (account.windows ?? []).filter((window) => Boolean(window) && !window.tier && window.state === "exhausted");
}

function soonestReset(windows: readonly UsageWindow[]): string | null {
	let best: number | undefined;
	let iso: string | null = null;
	for (const window of windows) {
		if (!window.resetsAt) continue;
		const at = Date.parse(window.resetsAt);
		if (!Number.isFinite(at)) continue;
		if (best === undefined || at < best) {
			best = at;
			iso = window.resetsAt;
		}
	}
	return iso;
}

/**
 * Every blackout the current reads justify.
 *
 * Only positive evidence counts. A provider that reports no quota at all
 * produces no blackout, because an ordinary API key or a local endpoint has
 * nothing to exhaust and must never be routed around.
 */
export function deriveBlackouts(
	snapshot: UsageSnapshot | null | undefined,
	openRouter?: OpenRouterAccountSnapshot | null,
): ProviderBlackout[] {
	const now = new Date().toISOString();
	const blackouts: ProviderBlackout[] = [];
	for (const account of snapshot?.available ? (snapshot.accounts ?? []) : []) {
		if (!account?.provider) continue;
		if (account.disabled) {
			blackouts.push({
				provider: account.provider,
				accountId: account.id,
				kind: "quota",
				since: now,
				until: null,
				reason: account.disabled.cause ?? "credential disabled",
			});
			continue;
		}
		const exhausted = untieredExhausted(account);
		if (exhausted.length === 0) continue;
		blackouts.push({
			provider: account.provider,
			accountId: account.id,
			kind: "quota",
			since: now,
			until: soonestReset(exhausted),
			reason: exhausted[0].label,
		});
	}

	// A prepaid balance is not a window: it does not refill on a schedule, so
	// the blackout carries no expiry and is lifted only by seeing money.
	// A FAILED balance read is not a zero balance and must not black out the
	// gateway — `available` is what separates the two.
	if (openRouter?.available && openRouter.credits && openRouter.credits.remaining <= 0) {
		blackouts.push({
			provider: OPENROUTER_PROVIDER,
			accountId: null,
			kind: "credits",
			since: now,
			until: null,
			reason: "out of credits",
		});
	}
	return blackouts;
}

function blackoutWindow(blackout: ProviderBlackout): UsageWindow {
	return {
		id: `${blackout.provider}:blackout`,
		label: blackout.reason || (blackout.kind === "credits" ? "out of credits" : "usage limit"),
		utilization: 100,
		resetsAt: blackout.until,
		state: "exhausted",
		windowMs: null,
		tier: null,
		shared: true,
	};
}

/**
 * The snapshot every consumer should actually read: live telemetry with
 * remembered exhaustion re-asserted on top.
 *
 * An account that is already reporting its own exhaustion is left untouched
 * — the live numbers are better copy than a synthetic window. Memory only
 * fills gaps: an account that has gone quiet, or a provider that vanished
 * from the report entirely.
 */
export function applyBlackouts(
	snapshot: UsageSnapshot,
	memory: RouteMemory,
	now = Date.now(),
): UsageSnapshot {
	const active = memory.blackouts.filter((blackout) => blackoutActive(blackout, now));
	if (active.length === 0) return snapshot;

	const accounts = (snapshot.accounts ?? []).map((account) => {
		const blackout = active.find((entry) => entry.provider === account.provider
			&& (entry.accountId === null || entry.accountId === account.id));
		if (!blackout) return account;
		if (untieredExhausted(account).length > 0) return account;
		return { ...account, windows: [...(account.windows ?? []), blackoutWindow(blackout)] };
	});

	for (const blackout of active) {
		if (accounts.some((account) => account.provider === blackout.provider)) continue;
		// No live account at all: the provider dropped out of the report while
		// still spent. Synthesize exactly enough for routing to see it, and
		// label it so the quota popup does not pass it off as a live read.
		accounts.push({
			provider: blackout.provider,
			id: blackout.accountId ?? `${blackout.provider}#remembered`,
			identity: null,
			credentialId: null,
			label: blackout.provider,
			planType: null,
			unlimited: false,
			windows: [blackoutWindow(blackout)],
		});
	}

	return { ...snapshot, accounts };
}
