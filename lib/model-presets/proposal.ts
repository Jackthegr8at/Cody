/**
 * Pure diffing between a preset's current roles/chains and a research
 * proposal for it, so the "apply to an already-configured preset" confirm
 * dialog can say exactly what changes instead of a blanket "this replaces
 * everything" that would be equally true for a brand-new preset.
 */
import type { ModelPreset, PresetProposal } from "./types";

export interface ProposalRoleDiff {
  role: string;
  before: string;
  after: string;
}

export interface ProposalDiff {
  /** Only roles whose stored selector actually differs, name-sorted. */
  roles: ProposalRoleDiff[];
  /** Chain keys whose entries differ in length or content, sorted. */
  chainsChanged: string[];
  usageAwareChanged: boolean;
}

export function diffPresetProposal(
  preset: Pick<ModelPreset, "roles" | "chains" | "usageAwareFallback">,
  proposal: PresetProposal,
): ProposalDiff {
  const roles: ProposalRoleDiff[] = [];
  for (const role of new Set([...Object.keys(preset.roles), ...Object.keys(proposal.roles)])) {
    const before = preset.roles[role] ?? "";
    const after = proposal.roles[role] ?? "";
    if (before !== after) roles.push({ role, before, after });
  }

  const chainsChanged: string[] = [];
  for (const key of new Set([...Object.keys(preset.chains), ...Object.keys(proposal.chains)])) {
    const before = preset.chains[key] ?? [];
    const after = proposal.chains[key] ?? [];
    if (before.length !== after.length || before.some((entry, index) => entry !== after[index])) chainsChanged.push(key);
  }

  return {
    roles: roles.sort((a, b) => a.role.localeCompare(b.role)),
    chainsChanged: chainsChanged.sort(),
    usageAwareChanged: (preset.usageAwareFallback ?? null) !== (proposal.usageAwareFallback ?? null),
  };
}
