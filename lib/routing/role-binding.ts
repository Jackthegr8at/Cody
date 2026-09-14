/**
 * Keeping omp's model ROLES pointed at a provider that can actually answer.
 *
 * The problem this solves is not theoretical. With
 * `modelRoles.default = openai-codex/gpt-6-astra` and Codex's weekly quota
 * spent, every new session, every `task` subagent, every commit message and
 * every session-name call starts by dialling a dead provider. omp's own
 * retry and usage-aware fallback do recover — per request, after the fact,
 * and loudly. The chain is already written down in
 * `retry.fallbackChains`; nothing was reading it up front.
 *
 * So Cody re-points the role at the first entry of the USER's own chain that
 * is not blacked out, and remembers the user's assignment as the baseline to
 * restore. The write lands in config.yml's `modelRoles`, which omp re-reads
 * per subagent spawn — so it reaches subagent routing, which Cody has no
 * other lever on, as well as the main model.
 *
 * Three rules keep this from being a config hijack:
 *
 * 1. The baseline is never lost. It is stored before the first rebinding and
 *    restored verbatim the moment its target is usable again.
 * 2. The user always wins. If `modelRoles[role]` no longer matches what Cody
 *    wrote, the user (or Settings) changed it: Cody adopts the new value as
 *    the baseline and re-decides from there.
 * 3. Nothing happens without positive evidence. A role whose target reports
 *    no quota at all is left exactly as configured.
 */

import { resolveModelAvailability } from "../usage/availability";
import type { UsageSnapshot } from "../usage/types";
import { readModelRoles, writeModelRoles } from "../omp/model-roles";
import { clearRoleBinding, readRouteMemory, writeRoleBinding, type RoleBinding } from "./route-memory";

/** omp appends a reasoning level to a role selector (`…/gpt-6-astra:medium`).
 * A model id may itself contain a colon (`moonshotai/kimi-k2.6:free`), so only
 * a known level is treated as a suffix. */
const THINKING_SUFFIXES: Record<string, true> = {
	off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, auto: true,
};

export interface ParsedSelector {
	provider: string;
	modelId: string;
	/** The `:level` suffix, kept so a restore or a rebinding preserves it. */
	suffix: string;
}

export function parseRoleSelector(selector: string): ParsedSelector | null {
	const trimmed = selector.trim();
	if (!trimmed) return null;
	let body = trimmed;
	let suffix = "";
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0 && THINKING_SUFFIXES[trimmed.slice(colon + 1).toLowerCase()]) {
		body = trimmed.slice(0, colon);
		suffix = trimmed.slice(colon);
	}
	const slash = body.indexOf("/");
	if (slash <= 0 || slash === body.length - 1) return null;
	return { provider: body.slice(0, slash), modelId: body.slice(slash + 1), suffix };
}

export interface RoleBindingChange {
	role: string;
	from: string;
	to: string;
	/** "bound" = routed around a blackout; "restored" = the baseline came back. */
	kind: "bound" | "restored";
	reason: string;
}

export interface RoleBindingInput {
	snapshot: UsageSnapshot | null;
	/** `retry.fallbackChains` exactly as configured, in the user's order. */
	chains: Record<string, string[]>;
}

export interface RoleBindingResult {
	changes: RoleBindingChange[];
	/** The role assignments after reconciliation, whether or not anything moved. */
	roles: Record<string, string>;
}

function usable(snapshot: UsageSnapshot | null, selector: string): boolean {
	const parsed = parseRoleSelector(selector);
	// An unparseable selector (a bare role alias, a wildcard) is left alone:
	// Cody cannot reason about it, and guessing would be worse than nothing.
	if (!parsed) return true;
	return resolveModelAvailability(snapshot, parsed.provider, parsed.modelId).state !== "exhausted";
}

/**
 * Decide every role's assignment against the current snapshot, writing
 * config.yml only when something actually moved.
 */
export function reconcileRoleBindings(input: RoleBindingInput): RoleBindingResult {
	const { roles } = readModelRoles();
	const memory = readRouteMemory();
	const next: Record<string, string> = { ...roles };
	const changes: RoleBindingChange[] = [];

	for (const [role, current] of Object.entries(roles)) {
		if (typeof current !== "string" || !current.trim()) continue;
		const binding: RoleBinding | undefined = memory.bindings[role];
		// Rule 2: an assignment Cody did not write is the user's word.
		const baseline = binding && binding.active === current ? binding.baseline : current;

		if (usable(input.snapshot, baseline)) {
			if (binding) {
				clearRoleBinding(role);
				if (current !== baseline) {
					next[role] = baseline;
					changes.push({ role, from: current, to: baseline, kind: "restored", reason: "quota restored" });
				}
			}
			continue;
		}

		const chain = input.chains[role] ?? [];
		const alternative = chain.find((entry) => entry !== baseline && usable(input.snapshot, entry));
		if (!alternative) {
			// Nothing in the user's chain can serve either. Leave the role as
			// configured: omp's own retry is still there, and inventing a
			// destination the user never listed is not Cody's call.
			continue;
		}
		if (alternative === current && binding) continue;

		const parsedBaseline = parseRoleSelector(baseline);
		const reason = parsedBaseline
			? `${parsedBaseline.provider} is out of quota`
			: "configured model is out of quota";
		next[role] = alternative;
		writeRoleBinding({ role, baseline, active: alternative, reason, boundAt: new Date().toISOString() });
		changes.push({ role, from: current, to: alternative, kind: "bound", reason });
	}

	if (changes.length > 0) writeModelRoles(next);
	return { changes, roles: next };
}
