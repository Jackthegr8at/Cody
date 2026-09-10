import { isRecord } from "../type-guards";
import type { PlanOverlay, TodoPhase } from "../pi-types";

/**
 * What the plan keeper asks the cheap model for, and how it reads the answer.
 *
 * The rule this exists to enforce: report ONLY what the digest evidences.
 * The model sees a compact log of recent activity and the current todo list
 * and is asked for nothing more than what changed — never asked to guess at
 * progress, and told explicitly that inventing a task or subtask that is not
 * already listed is wrong. lib/plan-keeper/keeper.ts applies a second,
 * server-side guard on top of this (evidence for gated tasks, never
 * un-completing) — this prompt is the first line of defense, not the only one.
 */

export const MAX_SUBTASKS = 4;
const MAX_SUBTASK_WORDS = 8;

export const PLAN_KEEPER_SYSTEM_PROMPT = [
  "You watch a coding agent's recent activity and keep its todo list current.",
  "Answer with ONE JSON object and nothing else: no prose, no explanation, no markdown fence.",
  'Shape: {"completed":["..."],"subtasks":{"<in_progress task content>":["..."]},"subtasksCompleted":["..."]}.',
  "\"completed\" lists the EXACT content of tasks the digest shows were actually finished. Never include a task that merely seems likely to be done — only one the digest directly evidences.",
  `"subtasks" may add up to ${MAX_SUBTASKS} short (${MAX_SUBTASK_WORDS} words or fewer) steps under the ONE task currently in_progress, and only when the digest shows distinct sub-steps of that specific task happening. The key must be that task's exact content, character for character.`,
  "\"subtasksCompleted\" lists the exact content of subtasks — already listed, or ones you are adding in this same answer — that the digest shows are done.",
  "Never invent a task or subtask that is not already listed above, and never report progress the digest does not show. When nothing changed, answer with empty lists and an empty object.",
].join(" ");

export type PlanKeeperDigestEntry =
  | { kind: "tool"; at: number; text: string }
  | { kind: "subagent"; at: number; text: string }
  | { kind: "message"; at: number; text: string }
  | { kind: "turn_end"; at: number };

function formatPhase(phase: TodoPhase, overlay: PlanOverlay): string {
  const lines = [`Phase: ${phase.name}`];
  for (const task of phase.tasks) {
    lines.push(`- (${task.status}) ${task.content}`);
    for (const subtask of overlay.subtasks[task.content] ?? []) {
      lines.push(`    - (${subtask.status}) ${subtask.content}`);
    }
  }
  return lines.join("\n");
}

/** The system prompt and the user prompt for one plan-keeper pass. */
export function buildPlanKeeperPrompt(
  phases: readonly TodoPhase[],
  overlay: PlanOverlay,
  digest: readonly PlanKeeperDigestEntry[],
): { systemPrompt: string; prompt: string } {
  const phasesText = phases.length > 0 ? phases.map((phase) => formatPhase(phase, overlay)).join("\n\n") : "(no phases)";
  const digestText = digest.length > 0
    ? digest.map((entry) => (entry.kind === "turn_end" ? "[turn end]" : `[${entry.kind}] ${entry.text}`)).join("\n")
    : "(nothing recorded yet)";
  return {
    systemPrompt: PLAN_KEEPER_SYSTEM_PROMPT,
    prompt: ["Current todo list:", phasesText, "", "Recent activity, oldest first:", digestText].join("\n"),
  };
}

/**
 * Return the outermost balanced `{...}`, tolerating a code fence or stray
 * prose around it and ignoring braces inside strings. Mirrors
 * lib/model-plan/planner.ts's scanner, kept as its own copy: the two features
 * share no other code and a cross-import would be a strange edge for a dozen
 * lines with no state.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && (depth -= 1) === 0) return text.slice(start, index + 1);
  }
  return null;
}

/** Longer than MAX_SUBTASK_WORDS words: cut to the first MAX_SUBTASK_WORDS —
 * a cheap model is not always obeyed the first time, and a hard cap here
 * matters more than a graceful one. */
function capWords(text: string): string {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  return words.length <= MAX_SUBTASK_WORDS ? trimmed : words.slice(0, MAX_SUBTASK_WORDS).join(" ");
}

export interface PlanKeeperAnswer {
  completed: string[];
  subtasks: Record<string, string[]>;
  subtasksCompleted: string[];
}

/**
 * Lenient parse of the model's answer: find the JSON object wherever it is,
 * coerce every field defensively, and drop anything unknown-shaped rather
 * than fail the whole answer over one bad field. Null only when there is no
 * JSON object in the text at all — the caller treats that as "nothing to
 * apply", same as an empty answer.
 */
export function parsePlanKeeperAnswer(raw: string): PlanKeeperAnswer | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const completed = Array.isArray(parsed.completed)
    ? parsed.completed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  const subtasks: Record<string, string[]> = {};
  if (isRecord(parsed.subtasks)) {
    for (const [key, value] of Object.entries(parsed.subtasks)) {
      if (!key.trim() || !Array.isArray(value)) continue;
      const items = value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .slice(0, MAX_SUBTASKS)
        .map(capWords);
      if (items.length > 0) subtasks[key] = items;
    }
  }

  const subtasksCompleted = Array.isArray(parsed.subtasksCompleted)
    ? parsed.subtasksCompleted.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  return { completed, subtasks, subtasksCompleted };
}
