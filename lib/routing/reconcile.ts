/**
 * The one pass that turns observed quota into routing decisions.
 *
 * Order matters and is the whole design:
 *
 *   observe → remember → bind roles → bind agents
 *
 * 1. `deriveBlackouts` reads the live snapshot (and OpenRouter's balance)
 *    for positive evidence of exhaustion.
 * 2. `recordBlackouts` persists it with the provider's own reset time, so
 *    the decision survives a quiet or failed telemetry read — the whole
 *    point of "don't dial that provider again until it is actually back".
 * 3. `reconcileRoleBindings` re-points each omp role at the first entry of
 *    the USER's fallback chain that is not blacked out, remembering their
 *    original assignment to restore.
 * 4. `planAgentRoleOverrides` makes every subagent resolve through a ROLE
 *    rather than a model name, so step 3 reaches subagent routing too.
 *
 * It runs on the server, off the usage read every client already performs,
 * and it writes nothing when nothing moved.
 */

import { getHarness } from "../harness";
import { readAgentModelOverrides, writeAgentModelOverrides } from "../omp/agent-model-overrides";
import { readNativeSettings } from "../omp/settings-config";
import { applyBlackouts, deriveBlackouts } from "./blackouts";
import { planAgentRoleOverrides, type AgentRoleChange } from "./agent-roles";
import { reconcileRoleBindings, type RoleBindingChange } from "./role-binding";
import { readRouteMemory, recordBlackouts, type ProviderBlackout } from "./route-memory";
import type { OpenRouterAccountSnapshot } from "../openrouter/account";
import type { UsageSnapshot } from "../usage/types";

export interface RoutingReconciliation {
	blackouts: ProviderBlackout[];
	roleChanges: RoleBindingChange[];
	agentChanges: AgentRoleChange[];
	/** The snapshot with remembered exhaustion folded in — what callers
	 * should hand to availability and to the UI. */
	snapshot: UsageSnapshot;
}

export interface ReconcileDeps {
	agents?: readonly string[];
	catalog?: readonly string[];
	openRouter?: OpenRouterAccountSnapshot | null;
}

/**
 * Reconcile routing against one snapshot. omp-only: every write targets
 * omp's config.yml, and no other engine has roles or fallback chains to
 * bind. Never throws — a routing optimization must not be able to break a
 * usage read.
 */
export function reconcileRouting(snapshot: UsageSnapshot, deps: ReconcileDeps = {}): RoutingReconciliation {
	const empty: RoutingReconciliation = { blackouts: [], roleChanges: [], agentChanges: [], snapshot };
	if (getHarness().id !== "omp") return empty;
	try {
		const blackouts = deriveBlackouts(snapshot, deps.openRouter);
		const remembered = recordBlackouts(blackouts);
		const effective = applyBlackouts(snapshot, { blackouts: remembered, bindings: readRouteMemory().bindings });

		const chains = readNativeSettings().settings.retry?.fallbackChains ?? {};
		const { changes: roleChanges } = reconcileRoleBindings({ snapshot: effective, chains });

		let agentChanges: AgentRoleChange[] = [];
		if (deps.agents && deps.agents.length > 0) {
			const overrides = readAgentModelOverrides();
			const planned = planAgentRoleOverrides({
				overrides,
				agents: deps.agents,
				catalog: deps.catalog ?? [],
				snapshot: effective,
			});
			if (planned.changes.length > 0) {
				writeAgentModelOverrides(planned.overrides);
				agentChanges = planned.changes;
			}
		}
		return { blackouts: remembered, roleChanges, agentChanges, snapshot: effective };
	} catch {
		return empty;
	}
}

