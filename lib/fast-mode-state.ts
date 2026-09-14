/**
 * The composer's Fast control has two authorities and they disagree often
 * enough that the derivation is worth naming: `supported` is a prediction
 * from catalog metadata, while `active` / `unavailable` are the live
 * engine's answer. The engine outranks the catalog.
 *
 * `"unavailable"` is the render-NOTHING state. A control whose only message
 * is that it cannot work costs composer width on every phone and teaches
 * the user nothing; its absence is the message.
 */

export type FastModeState = "checking" | "requested" | "inactive" | "unverified" | "off" | "unavailable";

export interface FastModeInput {
	/** The engine publishes a Fast surface at all. */
	capable?: boolean;
	/** Catalog metadata for the selected model. `undefined` = nobody checked. */
	supported?: boolean;
	/** The user's stored preference. */
	enabled?: boolean;
	/** The engine confirmed it is requesting priority. */
	active?: boolean;
	/** The engine explicitly rejected Fast for this model/session. */
	unavailable?: boolean;
	/** A toggle is in flight. */
	pending?: boolean;
}

export function deriveFastModeState(input: FastModeInput): FastModeState {
	if (!input.capable) return "unavailable";
	// A live rejection and a catalog that says "no" are the same answer, and
	// both outrank a stored preference: an enabled-but-rejected Fast is not a
	// control the user can do anything useful with.
	if (input.unavailable === true || input.supported === false) return "unavailable";
	if (input.pending) return "checking";
	if (input.active === true) return "requested";
	if (input.enabled && input.active === false) return "inactive";
	if (input.enabled) return "unverified";
	return input.supported === true ? "off" : "unverified";
}
