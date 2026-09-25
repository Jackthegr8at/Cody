import { providerOf, resolveRosterModel } from "./derive";
import { bestAvailableModel } from "./derive";
import type { RosterModel } from "./roster";

/**
 * Which roster models can honestly run a one-shot JSON-answering planner, and
 * which one to suggest by default. Shared by the model-roles planner
 * (`/api/model-plan`) and the researched-preset planner (`/api/model-presets/research`):
 * both hand a model the same kind of job (read a big JSON roster, answer with
 * JSON), so both need the same "can this model even hold the prompt" floor
 * and the same "prefer the user's own non-local default" suggestion.
 */

/** A planner must read the full roster and return JSON. A catalog may omit a
 * context limit, but a published tiny limit cannot hold that request. */
export const MIN_PLANNER_CONTEXT = 8_000;

export function plannerCandidates(models: RosterModel[]): RosterModel[] {
  return models.filter(
    (model) => model.contextWindow === null || model.contextWindow >= MIN_PLANNER_CONTEXT,
  );
}

export function savedDefaultProvider(defaultSelector: string | undefined, roster: RosterModel[]): string | undefined {
  if (!defaultSelector) return undefined;
  return resolveRosterModel(defaultSelector, roster)?.provider ?? providerOf(defaultSelector);
}

export function suggestedPlanner(
  defaultSelector: string | undefined,
  candidates: RosterModel[],
  preferredProvider: string | undefined,
): RosterModel | null {
  const current = defaultSelector ? resolveRosterModel(defaultSelector, candidates) : null;
  if (current && !current.local) return current;
  return bestAvailableModel(candidates, { preferredProvider });
}
