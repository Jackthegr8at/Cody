/**
 * Is this instance actually set up? Derived from FACTS, never from a flag
 * saying the wizard was shown.
 *
 * The distinction is the whole point. `setupDone` records that the user
 * finished or skipped the wizard, and it correctly stops Cody nagging — but it
 * says nothing about whether the instance works. A fresh install that clicked
 * "decide later" had `setupDone: true`, no engine binary, no credentials, and
 * a chat that failed with the engine's own CLI advice. Readiness is therefore
 * computed from three things a stranger can verify on screen:
 *
 *   engine   — an engine is installed AND active (nothing works without one)
 *   provider — at least one provider is connected (a sign-in or a key)
 *   models   — the catalog has at least one model to send a turn to
 *
 * They are ordered by dependency: a provider cannot be read before an engine
 * exists to read it, and a model cannot exist before a provider serves one.
 * `missingRequirements` returns them in that order, so the first entry is
 * always the thing to fix next — which is what the wizard opens on and what
 * the resume affordance names.
 *
 * Pure: no I/O and no engine import, so the same functions answer the hook,
 * the wizard's per-step gating and the unit test.
 */

/** Ordered by dependency: each one needs the one before it. */
export const SETUP_REQUIREMENTS = ["engine", "provider", "models"] as const;

export type SetupRequirement = (typeof SETUP_REQUIREMENTS)[number];

export interface SetupReadiness {
	engine: boolean;
	provider: boolean;
	models: boolean;
	/**
	 * A fact could not be read yet — a request in flight, a cold catalog cache,
	 * or a route that answered `unsupported`. Callers MUST treat this as "do
	 * not judge yet" rather than as "not ready": announcing a missing provider
	 * because the answer had not arrived is how a working instance gets told it
	 * is broken.
	 */
	pending: boolean;
}

export const UNKNOWN_READINESS: SetupReadiness = { engine: false, provider: false, models: false, pending: true };

/**
 * What still needs doing, nearest dependency first. Empty while `pending`:
 * an unread fact is never reported as a missing one.
 */
export function missingRequirements(readiness: SetupReadiness): SetupRequirement[] {
	if (readiness.pending) return [];
	return SETUP_REQUIREMENTS.filter((requirement) => !readiness[requirement]);
}

/** Nothing left to do, and we actually know it. */
export function isSetupComplete(readiness: SetupReadiness): boolean {
	return !readiness.pending && missingRequirements(readiness).length === 0;
}

/**
 * The inputs, each shaped as the route that carries it actually answers, so
 * the caller does no interpretation of its own.
 *
 * `engines`/`providers` are null while unread. A provider list that is present
 * but empty is a real answer (no providers connected), not an unread one.
 */
export interface SetupInputs {
	engines: { engines?: ReadonlyArray<{ id?: string; installed?: boolean }>; active?: string | null } | null;
	providers: { providers?: ReadonlyArray<{ connected?: boolean; modelCount?: number | null }>; pending?: { counts?: boolean } } | null;
}

export function deriveReadiness(inputs: SetupInputs): SetupReadiness {
	const { engines, providers } = inputs;
	if (!engines) return UNKNOWN_READINESS;
	// Active AND installed. The persisted selection is a preference; the binary
	// is the capability, and a card reading "not installed" beside "active
	// engine" is exactly the state this catches.
	const active = engines.engines?.find((engine) => engine.id === engines.active);
	const engine = active?.installed === true;
	// Without an engine there is nothing to have read a provider or a catalog
	// FROM, so both stay unknown rather than false: an empty provider list
	// under no engine is an artefact, not a finding.
	if (!engine) return { engine: false, provider: false, models: false, pending: false };
	if (!providers) return { engine, provider: false, models: false, pending: true };
	const rows = providers.providers ?? [];
	const provider = rows.some((row) => row.connected === true);
	// A cached provider read may not have counted models yet. Connected with an
	// uncounted catalog is "pending", not "no models".
	const counted = rows.reduce((total, row) => total + (typeof row.modelCount === "number" ? row.modelCount : 0), 0);
	const countsPending = providers.pending?.counts === true;
	if (provider && counted === 0 && countsPending) return { engine, provider, models: false, pending: true };
	return { engine, provider, models: counted > 0, pending: false };
}
