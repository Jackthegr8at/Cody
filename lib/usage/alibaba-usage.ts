/**
 * Alibaba Cloud Model Studio **Token Plan** quota, for the composer ring.
 *
 * omp has no usage provider for `alibaba-token-plan` — verified against the
 * installed source: `cli/usage-cli.ts` filters reports through
 * `authStorage.usageProviderFor(provider)`, and only `openai-codex` and
 * `anthropic` have one. So `omp usage --json` reports nothing for the plan,
 * and the ring had nothing to show.
 *
 * The plan itself does report. Alibaba's own CLI (`bailian-cli`, binaries
 * `bl` / `bailian`) calls `/tokenplan/personal/api/v2/usage`, which answers
 * `{per5HourPercentage, per1WeekPercentage, per5HourResetTime,
 * per1WeekResetTime}` — a 5-hour and a weekly window, exactly the shape
 * Cody already models for Claude and Codex.
 *
 * Cody shells out to that CLI rather than calling the endpoint itself,
 * because the endpoint is CONSOLE-authenticated (`auth: "console"` in the
 * CLI's own command definition): the `sk-sp-` inference key cannot read it,
 * and re-implementing Alibaba's console signing inside Cody would mean
 * holding AccessKey secrets it has no other reason to hold.
 *
 * Absence is reported, never guessed: no CLI, or a CLI that is not signed
 * in, is a typed reason the UI can turn into "connect this", not a missing
 * provider and never a zero balance.
 */

import { execFile } from "child_process";
import { deriveUsageWindowState } from "./omp-usage";
import type { UsageAccount, UsageWindow } from "./types";

export const ALIBABA_TOKEN_PLAN_PROVIDER = "alibaba-token-plan";

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type AlibabaUsageUnavailableReason = "not_installed" | "not_authenticated" | "failed";

export type AlibabaUsageResult =
	| { account: UsageAccount }
	| { unavailable: true; reason: AlibabaUsageUnavailableReason; detail?: string };

interface RawUsage {
	per5HourPercentage?: unknown;
	per1WeekPercentage?: unknown;
	per5HourResetTime?: unknown;
	per1WeekResetTime?: unknown;
}

function binaryCandidates(): string[] {
	const override = process.env.CODY_BAILIAN_BIN?.trim();
	return override ? [override] : ["bl", "bailian"];
}

function run(bin: string): Promise<{ ok: true; stdout: string } | { ok: false; code: string; detail: string }> {
	const { promise, resolve } = Promise.withResolvers<{ ok: true; stdout: string } | { ok: false; code: string; detail: string }>();
	try {
		// Fixed argv, no shell: nothing user-controlled reaches the command line.
		execFile(bin, ["usage", "--output", "json"], { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout, stderr) => {
			if (!error) return resolve({ ok: true, stdout });
			const code = (error as NodeJS.ErrnoException).code ?? "";
			resolve({ ok: false, code: String(code), detail: (stderr || error.message || "").slice(0, 400) });
		});
	} catch (error) {
		resolve({ ok: false, code: "spawn_failed", detail: error instanceof Error ? error.message : String(error) });
	}
	return promise;
}

/** Percentages arrive as fractions of the plan CONSUMED. */
function toUtilization(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	// Tolerate either convention: a fraction (0.42) or a percentage (42).
	const percent = value <= 1 ? value * 100 : value;
	return Math.min(100, Math.round(percent * 10) / 10);
}

function toReset(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	const at = new Date(value);
	return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function buildWindow(id: string, label: string, windowMs: number, utilization: unknown, reset: unknown): UsageWindow | null {
	const value = toUtilization(utilization);
	// An absent percentage is an unlimited or unreported window, NOT an empty
	// one: reporting 0% would paint headroom nobody measured.
	if (value === null) return null;
	return {
		id: `${ALIBABA_TOKEN_PLAN_PROVIDER}:${id}`,
		label,
		utilization: value,
		resetsAt: toReset(reset),
		state: deriveUsageWindowState(value),
		windowMs,
		tier: null,
		shared: true,
	};
}

function parse(stdout: string): RawUsage | null {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		// The CLI has wrapped its payload in `data` in some versions.
		const body = record.data && typeof record.data === "object" && !Array.isArray(record.data)
			? record.data as Record<string, unknown>
			: record;
		return body as RawUsage;
	} catch {
		return null;
	}
}

export async function fetchAlibabaTokenPlanUsage(): Promise<AlibabaUsageResult> {
	let lastFailure: { code: string; detail: string } | null = null;
	for (const bin of binaryCandidates()) {
		const result = await run(bin);
		if (!result.ok) {
			if (result.code === "ENOENT") continue;
			lastFailure = result;
			continue;
		}
		const raw = parse(result.stdout);
		if (!raw) return { unavailable: true, reason: "failed", detail: "unrecognized usage payload" };
		const windows = [
			buildWindow("5h", "5 hours", FIVE_HOURS_MS, raw.per5HourPercentage, raw.per5HourResetTime),
			buildWindow("7d", "7 days", ONE_WEEK_MS, raw.per1WeekPercentage, raw.per1WeekResetTime),
		].filter((window): window is UsageWindow => window !== null);
		return {
			account: {
				provider: ALIBABA_TOKEN_PLAN_PROVIDER,
				id: ALIBABA_TOKEN_PLAN_PROVIDER,
				identity: null,
				credentialId: null,
				label: "Alibaba Token Plan",
				planType: null,
				// No reported window means the plan reports nothing measurable,
				// which is not the same as unlimited.
				unlimited: false,
				windows,
			},
		};
	}
	if (!lastFailure) return { unavailable: true, reason: "not_installed" };
	const detail = lastFailure.detail.toLowerCase();
	const unauthenticated = detail.includes("login") || detail.includes("auth") || detail.includes("credential") || detail.includes("401");
	return { unavailable: true, reason: unauthenticated ? "not_authenticated" : "failed", detail: lastFailure.detail };
}
