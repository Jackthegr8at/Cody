"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deriveReadiness, type SetupReadiness, UNKNOWN_READINESS } from "@/lib/setup-status";

/**
 * Whether this instance is set up, read from the two CHEAP routes that carry
 * the facts: `/api/engines` (what is installed and active) and
 * `/api/providers?cached=1` (what is connected, and how many models each
 * provider serves).
 *
 * `?cached=1` matters: the uncached provider list and `/api/models` both start
 * the engine's utility child. Onboarding status is ambient — it is consulted
 * on every page load and after every wizard step — so it must never be the
 * thing that spawns a process. A cold cache answers `pending`, which the
 * readiness model already treats as "do not judge yet".
 *
 * Deliberately not a `useSettingsData` route hook: that cache belongs to the
 * Settings dialog's lifecycle, while this is read by the app shell before any
 * dialog exists.
 */
export interface SetupStatus {
	readiness: SetupReadiness;
	/** Re-read both facts — call after an install, a sign-in, or a wizard step. */
	refresh: () => void;
	/** The engine roster, reused by the wizard's engine step so it does not refetch. */
	engines: unknown;
}

export function useSetupStatus(enabled = true): SetupStatus {
	const [readiness, setReadiness] = useState<SetupReadiness>(UNKNOWN_READINESS);
	const [engines, setEngines] = useState<unknown>(null);
	const [seq, setSeq] = useState(0);
	// A refresh that lands after the component unmounted, or after a newer one
	// already answered, must not overwrite the current answer.
	const latest = useRef(0);

	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		const generation = ++latest.current;
		const read = async (url: string): Promise<Record<string, unknown> | null> => {
			try {
				const response = await fetch(url, { cache: "no-store", signal: controller.signal });
				// 401 on an open instance or a signed-out tab, 400 `unsupported`
				// from an engine that has no such surface: both are "unread", and
				// unread is pending, not broken.
				if (!response.ok) return null;
				return (await response.json()) as Record<string, unknown>;
			} catch {
				return null;
			}
		};
		void Promise.all([read("/api/engines"), read("/api/providers?cached=1")]).then(([enginesBody, providersBody]) => {
			if (controller.signal.aborted || generation !== latest.current) return;
			setEngines(enginesBody);
			setReadiness(deriveReadiness({
				engines: enginesBody as never,
				providers: providersBody as never,
			}));
		});
		return () => controller.abort();
	}, [enabled, seq]);

	const refresh = useCallback(() => setSeq((current) => current + 1), []);
	return { readiness, refresh, engines };
}
