/**
 * Pure display strings for the presets list and editor. Kept separate from
 * `selector.ts` (splitting one selector) and `proposal.ts` (diffing a
 * research proposal) because these additionally need a model's display
 * name — the one input that comes from the catalog, not from the preset
 * or the selector string itself.
 */
import { formatModelDisplayName } from "../model-display";
import type { PresetResearchStamp } from "./types";
import { splitPresetSelector } from "./selector";

export interface ModelNameLookup {
  provider: string;
  id: string;
  name: string;
}

/** The shape of `useI18n().t`, injected rather than imported so these stay
 *  plain functions a node test can call without React. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** `provider/modelId` → its catalog display name, or the bare selector
 *  when the catalog does not have it (not currently reachable, but the
 *  preset still names it — the same "still used until changed" stance the
 *  role picker itself takes). */
export function displayNameForModel(model: string, models: readonly ModelNameLookup[]): string {
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1);
  const known = models.find((entry) => entry.provider === provider && entry.id === id);
  return known ? formatModelDisplayName(id, known.name) : model;
}

/**
 * One line for a role: the model's display name plus its level when the
 * preset assigns one directly; otherwise, if the base config assigns one,
 * "Inherits base (<that model>)" — the exact wording the role picker's own
 * inherit option uses; otherwise "No default model set".
 */
export function describeRoleSelector(
  selector: string | undefined,
  base: string | undefined,
  models: readonly ModelNameLookup[],
  knownSelectors: ReadonlySet<string>,
  t: Translate,
): string {
  if (selector) {
    const split = splitPresetSelector(selector, knownSelectors);
    const name = displayNameForModel(split.model, models);
    return split.level ? `${name} · ${split.level}` : name;
  }
  if (base) {
    const split = splitPresetSelector(base, knownSelectors);
    const name = displayNameForModel(split.model, models);
    return t("presets.inheritsBase", { model: split.level ? `${name} · ${split.level}` : name });
  }
  return t("presets.noDefaultModel");
}

/** The list row's research-provenance line: "Researched with <planner> on
 *  <date>" or "Not configured yet" when the preset carries no stamp — that
 *  is, no research has EVER been applied, independent of whether its roles
 *  happen to be manually configured. `formatDate` is injected so this stays
 *  deterministic to test; the component passes `toLocaleDateString`. */
export function researchStampSummary(
  research: PresetResearchStamp | undefined,
  models: readonly ModelNameLookup[],
  knownSelectors: ReadonlySet<string>,
  formatDate: (iso: string) => string,
  t: Translate,
): string {
  if (!research) return t("presets.notConfiguredYet");
  const plannerModel = displayNameForModel(splitPresetSelector(research.plannerModel, knownSelectors).model, models);
  return t("presets.researchedWith", { model: plannerModel, date: formatDate(research.completedAt) });
}
