#!/usr/bin/env bun
/** Isolated Bun bridge to OMP's installed AuthStorage reset-credit API. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
console.log = (...args) => console.error(...args);
console.info = console.log;
console.debug = console.log;
function emit(value) { process.stdout.write(JSON.stringify(value)); }
function fail(type, code, message) { emit({ type, ok: false, code, message }); process.exitCode = 1; }
function opaqueId(value) { return createHash("sha256").update(value).digest("base64url"); }
function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
function date(value) { const time = typeof value === "string" || typeof value === "number" ? Date.parse(String(value)) : NaN; return Number.isFinite(time) ? new Date(time).toISOString() : null; }
function targetFor(account) {
  if (typeof account.credentialId === "number" && Number.isSafeInteger(account.credentialId)) return { credentialId: account.credentialId };
  if (typeof account.accountId === "string" && account.accountId) return { accountId: account.accountId };
  if (typeof account.email === "string" && account.email) return { email: account.email };
  return null;
}
function identityFor(account) { const target = targetFor(account); return target ? opaqueId("openai-codex:" + JSON.stringify(target)) : null; }
function labelFor(account, index) { const plan = typeof account.planType === "string" && account.planType.trim() ? " (" + account.planType.trim() + ")" : ""; return "OpenAI Codex" + plan + (index ? " " + (index + 1) : ""); }
function creditFor(value) { const credit = asRecord(value); if (!credit || typeof credit.id !== "string" || !credit.id || (typeof credit.status === "string" && credit.status !== "available")) return null; return { id: credit.id, expiresAt: date(credit.expiresAt ?? credit.expires_at ?? credit.expiry) }; }
function normalizeAccounts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    const account = asRecord(entry); const id = account && identityFor(account); if (!account || !id) return [];
    const credits = Array.isArray(account.credits) ? account.credits.map(creditFor).filter(Boolean) : [];
    credits.sort((left, right) => (left.expiresAt ? Date.parse(left.expiresAt) : Infinity) - (right.expiresAt ? Date.parse(right.expiresAt) : Infinity));
    const availableCount = typeof account.availableCount === "number" && Number.isFinite(account.availableCount) && account.availableCount >= 0 ? Math.floor(account.availableCount) : credits.length;
    return [{ id, label: labelFor(account, index), availableCount, canRedeem: !account.error && credits.length > 0, credits, ...(typeof account.error === "string" && account.error ? { error: account.error } : {}), _target: targetFor(account) }];
  });
}
async function loadStorage(packageRoot, agentDir) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const require = createRequire(join(packageRoot, "package.json"));
  let aiPath; let utilsPath;
  try { aiPath = require.resolve("@oh-my-pi/pi-ai/auth-storage.js"); utilsPath = require.resolve("@oh-my-pi/pi-utils/dirs.js"); } catch { throw new Error("OMP's installed reset-credit modules are unavailable."); }
  const ai = await import(pathToFileURL(aiPath).href); const utils = await import(pathToFileURL(utilsPath).href);
  if (typeof ai.AuthStorage?.create !== "function" || typeof utils.getAgentDbPath !== "function") throw new Error("Installed OMP does not expose AuthStorage reset-credit support.");
  const storage = await ai.AuthStorage.create(utils.getAgentDbPath()); await storage.reload(); return storage;
}
async function list(storage) { return storage.listResetCredits({ provider: "openai-codex" }); }
async function main() {
  let request; try { request = asRecord(JSON.parse(process.argv[2] ?? "")); } catch { return fail("error", "invalid_request", "Malformed reset-credit request."); }
  if (!request || (request.operation !== "list" && request.operation !== "redeem") || typeof request.packageRoot !== "string" || typeof request.agentDir !== "string") return fail("error", "invalid_request", "Malformed reset-credit request.");
  let storage;
  try { storage = await loadStorage(request.packageRoot, request.agentDir); } catch (error) { return fail(request.operation, "unsupported", error instanceof Error ? error.message : String(error)); }
  try {
    let raw; try { raw = await list(storage); } catch (error) { return fail(request.operation, "credit_list_failed", error instanceof Error ? error.message : String(error)); }
    const accounts = normalizeAccounts(raw);
    if (request.operation === "list") return emit({ type: "list", ok: true, accounts: accounts.map(({ id, label, availableCount, canRedeem, credits, error }) => ({ id, label, availableCount, canRedeem, credits, ...(error ? { error } : {}) })) });
    if (typeof request.accountId !== "string" || typeof request.creditId !== "string" || typeof request.idempotencyKey !== "string") return fail("redeem", "invalid_request", "Malformed redemption request.");
    const chosen = accounts.find((account) => account.id === request.accountId);
    if (!chosen) return emit({ type: "redeem", outcome: "error", code: "no_account", message: "The selected reset-credit account no longer exists." });
    if (chosen.error || !chosen._target) return emit({ type: "redeem", outcome: "error", code: "account_unavailable", message: chosen.error ?? "The selected account cannot redeem reset credits." });
    if (!chosen.credits.some((credit) => credit.id === request.creditId)) return emit({ type: "redeem", outcome: "no_credit", code: "no_credit" });
    try {
      // AuthStorage owns native request UUID generation and all provider cache/block cleanup.
      const result = await storage.redeemResetCredit({ target: chosen._target, provider: "openai-codex", creditId: request.creditId });
      const code = typeof result?.code === "string" ? result.code : "";
      const outcome = code === "already_redeemed" ? "already_redeemed" : code === "no_credit" ? "no_credit" : code === "nothing_to_reset" ? "nothing_to_reset" : result?.ok === true ? "reset" : "error";
      return emit({ type: "redeem", outcome, ...(code ? { code } : {}) });
    } catch (error) { return emit({ type: "redeem", outcome: "error", code: "unsupported", message: error instanceof Error ? error.message : String(error) }); }
  } finally { await storage.close?.(); }
}
main().catch((error) => fail("error", "unsupported", error instanceof Error ? error.message : String(error)));
