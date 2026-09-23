import { spawn } from "child_process";
import { existsSync } from "fs";
import { StringDecoder } from "string_decoder";
import path from "path";
import { readEnv } from "../env";
import { getAgentDir } from "../omp/paths";
import { findOmpPackageRoot } from "../omp/package-source";
import { resolveOmpBin } from "../omp/omp-cli";
import type { UsageSnapshot } from "../usage/types";

/**
 * "Retry now" for a rate-limit BLOCK: omp refused one credential after a
 * single rejected request and wrote a deadline. That is not a measurement,
 * so the owner may lift it by hand; if the provider really is still
 * limiting, the next request writes the block straight back.
 *
 * A measured exhaustion is different and is never lifted here: the usage
 * API is authoritative, and deleting a block beside it would only buy one
 * more rejected request.
 */
export type UnblockOutcome = "lifted" | "not_blocked" | "measured" | "error";

export interface UnblockResult {
  outcome: UnblockOutcome;
  message: string;
  code?: string;
  /** The block scopes that were lifted, with the deadline each carried. */
  cleared?: { scope: string | null; until: string | null }[];
}

export type UnblockPlan =
  | { kind: "run"; credentialId: number }
  | { kind: "done"; result: UnblockResult };

/**
 * Decide from the usage snapshot alone, before anything is spawned. The
 * snapshot already carries each account's credential row id (see
 * credential-order.ts), so the opaque account id maps back to it here and no
 * credential store has to be read to find it.
 */
export function planUnblock(snapshot: UsageSnapshot | null, provider: string, accountId: string): UnblockPlan {
  const account = (snapshot?.accounts ?? []).find((entry) => entry?.provider === provider && entry.id === accountId);
  if (!account) return { kind: "done", result: { outcome: "error", code: "no_account", message: "That account is not in the current usage reading." } };
  const windows = account.windows ?? [];
  const blocks = windows.filter((window) => window?.source === "block");
  if (blocks.length === 0) return { kind: "done", result: { outcome: "not_blocked", message: "This account has no rate-limit block to lift." } };
  const measured = windows.some((window) => window && window.source !== "block" && window.state === "exhausted" && !window.tier);
  if (measured) {
    return { kind: "done", result: { outcome: "measured", message: "This account's own usage reading says it is out of quota, so the block stays until that resets." } };
  }
  if (account.credentialId === null || !Number.isSafeInteger(account.credentialId)) {
    return { kind: "done", result: { outcome: "error", code: "no_credential", message: "Cody could not match this account to an omp credential." } };
  }
  return { kind: "run", credentialId: account.credentialId };
}

export interface OmpUnblockDeps { helperPath?: string; bunBin?: string; packageRoot?: () => string | null; agentDir?: () => string; }

function helperPath(): string {
  const packageDir = readEnv("PACKAGE_DIR") ?? path.resolve(import.meta.dirname, "../..");
  return path.join(packageDir, "bin", "cody-omp-unblock.mjs");
}

const HELPER_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function invoke(request: Record<string, unknown>, deps: OmpUnblockDeps): Promise<Record<string, unknown> | null> {
  const executable = deps.bunBin ?? readEnv("BUN_BIN") ?? "bun";
  const script = deps.helperPath ?? helperPath();
  if (!existsSync(script)) return Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers<Record<string, unknown> | null>();
  const decoder = new StringDecoder("utf8");
  let stdout = "";
  let child;
  try {
    child = spawn(executable, [script, JSON.stringify(request)], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    resolve(null);
    return promise;
  }
  let settled = false;
  const finish = (value: Record<string, unknown> | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, HELPER_TIMEOUT_MS);
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += decoder.write(chunk);
    if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
  });
  child.once("error", () => finish(null));
  child.once("close", () => {
    try {
      const parsed: unknown = JSON.parse(stdout + decoder.end());
      finish(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null);
    } catch {
      finish(null);
    }
  });
  return promise;
}

function safeString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }

/** Delete omp's block rows for one credential. Only ids and deadlines cross
 * the process boundary; the helper never loads a credential. */
export async function liftCredentialBlock(credentialId: number, deps: OmpUnblockDeps = {}): Promise<UnblockResult> {
  const packageRoot = deps.packageRoot ? deps.packageRoot() : (resolveOmpBin() ? findOmpPackageRoot() : null);
  if (!packageRoot) return { outcome: "error", code: "unsupported", message: "omp is not installed, so its rate-limit blocks cannot be changed." };
  const frame = await invoke({ operation: "unblock", packageRoot, agentDir: deps.agentDir?.() ?? getAgentDir(), credentialId }, deps);
  if (!frame || frame.type !== "unblock") return { outcome: "error", code: "inconclusive", message: "Lifting the block gave no answer; refresh before trying again." };
  if (frame.ok !== true) return { outcome: "error", code: safeString(frame.code) ?? "unblock_failed", message: safeString(frame.message) ?? "Lifting the block failed." };
  if (frame.outcome === "not_blocked") return { outcome: "not_blocked", message: "omp no longer holds a block on this account." };
  const cleared = Array.isArray(frame.cleared)
    ? frame.cleared.flatMap((entry): { scope: string | null; until: string | null }[] => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const row = entry as Record<string, unknown>;
        return [{ scope: safeString(row.scope), until: safeString(row.until) }];
      })
    : [];
  return { outcome: "lifted", message: "Block lifted. The next request will try this account again.", cleared };
}
