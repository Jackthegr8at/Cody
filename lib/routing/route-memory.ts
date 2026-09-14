/**
 * Cody's durable memory of which providers are spent, and of which model
 * actually served a role while one was.
 *
 * Why this file exists: a live quota snapshot is not enough to route well.
 * It is a 60-second cache that can go quiet (a failed read, an engine
 * restart, a provider that stops answering), and "no telemetry" reads as
 * "usable" — which is exactly how a session ends up dialling an account that
 * has been exhausted for days, every single turn. Remembering the
 * exhaustion, with the provider's OWN stated reset time as its expiry, is
 * what turns one observation into a routing decision that holds.
 *
 * Two kinds of memory live here:
 *
 * - **Blackouts.** A provider (optionally one account of it) is off the
 *   routing table until `until`. A quota blackout carries the reset the
 *   provider stated. A `credits` blackout (prepaid balances — OpenRouter)
 *   has NO expiry: money does not come back on a timer, so it clears only
 *   when a later read sees a positive balance.
 * - **Role bindings.** When a role's configured model is blacked out, Cody
 *   re-points that role at the first healthy entry of the user's own
 *   fallback chain, and keeps the user's original assignment as `baseline`
 *   so it can be restored exactly. Without the baseline the rebinding would
 *   be a one-way edit of the user's config.
 *
 * Cody-owned state: it lives in the instance data dir, never in omp's
 * config.yml, so an engine update or switch cannot lose or rewrite it.
 * Unknown top-level keys round-trip so a newer Cody's data survives an
 * older Cody's write.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import path from "path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";

export const ROUTE_MEMORY_FILE = "cody-route-memory.json";
const FILE_VERSION = 1;

export type BlackoutKind = "quota" | "credits";

export interface ProviderBlackout {
	provider: string;
	/** One account of the provider, or null for the provider as a whole. */
	accountId: string | null;
	kind: BlackoutKind;
	/** When Cody first observed the exhaustion. */
	since: string;
	/** Provider-stated reset. Null for a prepaid balance, which never
	 * refills on its own and is cleared by observation instead. */
	until: string | null;
	/** Human-facing reason, shown verbatim in the routing notice. */
	reason: string;
}

export interface RoleBinding {
	role: string;
	/** The user's own assignment, restored verbatim when it is usable again. */
	baseline: string;
	/** What Cody wrote into `modelRoles[role]` instead. */
	active: string;
	reason: string;
	boundAt: string;
}

export interface RouteMemory {
	blackouts: ProviderBlackout[];
	bindings: Record<string, RoleBinding>;
}

interface RouteMemoryFile extends RouteMemory {
	version: number;
	[extra: string]: unknown;
}

const EMPTY: RouteMemory = { blackouts: [], bindings: {} };

export function getRouteMemoryPath(): string {
	return path.join(getAgentDir(), ROUTE_MEMORY_FILE);
}

function normalizeBlackout(value: unknown): ProviderBlackout | null {
	if (!isRecord(value)) return null;
	const provider = typeof value.provider === "string" ? value.provider.trim() : "";
	if (!provider) return null;
	const kind: BlackoutKind = value.kind === "credits" ? "credits" : "quota";
	return {
		provider,
		accountId: typeof value.accountId === "string" && value.accountId ? value.accountId : null,
		kind,
		since: typeof value.since === "string" ? value.since : new Date().toISOString(),
		until: typeof value.until === "string" ? value.until : null,
		reason: typeof value.reason === "string" ? value.reason : "",
	};
}

function normalizeBinding(role: string, value: unknown): RoleBinding | null {
	if (!isRecord(value)) return null;
	const baseline = typeof value.baseline === "string" ? value.baseline : "";
	const active = typeof value.active === "string" ? value.active : "";
	if (!baseline || !active) return null;
	return {
		role,
		baseline,
		active,
		reason: typeof value.reason === "string" ? value.reason : "",
		boundAt: typeof value.boundAt === "string" ? value.boundAt : new Date().toISOString(),
	};
}

function readFile(): RouteMemoryFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(getRouteMemoryPath(), "utf8"));
	} catch {
		// Missing, unreadable and corrupt all mean the same thing: nothing is
		// remembered yet, which is the safe state — every model is usable.
		return { version: FILE_VERSION, ...EMPTY };
	}
	if (!isRecord(parsed)) return { version: FILE_VERSION, ...EMPTY };
	const blackouts = Array.isArray(parsed.blackouts)
		? parsed.blackouts.flatMap((entry) => { const normalized = normalizeBlackout(entry); return normalized ? [normalized] : []; })
		: [];
	const bindings: Record<string, RoleBinding> = {};
	if (isRecord(parsed.bindings)) {
		for (const [role, entry] of Object.entries(parsed.bindings)) {
			const normalized = normalizeBinding(role, entry);
			if (normalized) bindings[role] = normalized;
		}
	}
	const file = { ...parsed } as RouteMemoryFile;
	file.version = FILE_VERSION;
	file.blackouts = blackouts;
	file.bindings = bindings;
	return file;
}

function writeFile(file: RouteMemoryFile): void {
	const target = getRouteMemoryPath();
	mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
	writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, target);
}

/** Whether a remembered blackout still applies at `now`. A `credits`
 * blackout has no expiry by design — it is cleared by a positive balance,
 * never by the clock. */
export function blackoutActive(blackout: ProviderBlackout, now = Date.now()): boolean {
	if (blackout.kind === "credits") return true;
	if (!blackout.until) return true;
	const until = Date.parse(blackout.until);
	return Number.isFinite(until) ? until > now : true;
}

/** Everything remembered, with expired quota blackouts already dropped. */
export function readRouteMemory(now = Date.now()): RouteMemory {
	const file = readFile();
	return {
		blackouts: file.blackouts.filter((blackout) => blackoutActive(blackout, now)),
		bindings: { ...file.bindings },
	};
}

function sameTarget(a: ProviderBlackout, b: { provider: string; accountId: string | null }): boolean {
	return a.provider === b.provider && (a.accountId ?? null) === (b.accountId ?? null);
}

/**
 * Replace the remembered blackout set with `observed`, keeping the original
 * `since` of anything still blacked out.
 *
 * Wholesale replacement is deliberate: the caller derives `observed` from
 * one complete read, so a provider absent from it is a provider that is no
 * longer exhausted. Merging instead would make a blackout immortal the first
 * time a reset time was missing.
 */
export function recordBlackouts(observed: readonly ProviderBlackout[], now = Date.now()): ProviderBlackout[] {
	const file = readFile();
	const previous = file.blackouts.filter((blackout) => blackoutActive(blackout, now));
	const next = observed.map((blackout) => {
		const existing = previous.find((entry) => sameTarget(entry, blackout));
		return existing ? { ...blackout, since: existing.since } : blackout;
	});
	const changed = next.length !== previous.length
		|| next.some((blackout) => {
			const existing = previous.find((entry) => sameTarget(entry, blackout));
			return !existing || existing.until !== blackout.until || existing.kind !== blackout.kind;
		});
	if (changed) writeFile({ ...file, blackouts: next });
	return next;
}

export function writeRoleBinding(binding: RoleBinding): void {
	const file = readFile();
	writeFile({ ...file, bindings: { ...file.bindings, [binding.role]: binding } });
}

export function clearRoleBinding(role: string): void {
	const file = readFile();
	if (!(role in file.bindings)) return;
	const bindings = { ...file.bindings };
	delete bindings[role];
	writeFile({ ...file, bindings });
}
