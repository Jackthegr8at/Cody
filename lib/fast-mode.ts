import type { OmpModel } from "./omp/rpc-utility";

/**
 * Catalog prediction for model families that may accept the composer's Fast
 * priority request.
 *
 * Fast is not a generic "be quicker" switch: it asks the engine to request a
 * priority service tier for the selected model's provider family (the harness
 * exposes the same thing as `/fast`). Direct Anthropic may encode that as
 * `speed: "fast"` plus a beta header, and OpenAI-family requests may carry a
 * `service_tier` field. This predicate only classifies model metadata; it
 * cannot confirm that an engine accepted the request or that a provider is
 * servicing it. The live session's `fastModeActive` and explicit rejection
 * state are authoritative over this prediction.
 *
 * This restates upstream logic (`serviceTierFamily` +
 * `realizesPriorityServiceTier` in the harness's AI package) because Cody
 * cannot import it: those packages are Bun-only. That means it can drift, and
 * this is the file to re-check against upstream when a provider is added.
 *
 * Two deliberate omissions:
 * - Upstream also has a catalog-driven fallback that recognizes OpenAI-shaped
 *   models served by unrelated custom providers. Replicating it would need the
 *   catalog, so this predicate conservatively returns false for an exotic
 *   custom provider; a later live engine state can still supersede it.
 * - Fireworks is excluded on purpose. Priority is real there, but `/fast`
 *   does not drive it — it has its own separate provider tier setting, and
 *   upstream gives those models no service-tier family at all.
 */
export function supportsPriorityFastMode(model: Pick<OmpModel, "provider" | "api" | "id">): boolean {
  const provider = model.provider;
  // The catalog predicts direct Anthropic may accept the priority request.
  if (provider === "anthropic") return true;
  // Claude served by anyone else — Bedrock, Vertex, or an
  // Anthropic-compatible proxy — is cataloged as unsupported. A live engine
  // state update can still supersede this prediction.
  if (model.api === "anthropic-messages") return false;
  // The Codex subscription is its own provider id, distinct from the API's.
  // Missing it is what hid this control from Codex models.
  if (provider === "openai" || provider === "openai-codex") return true;
  if (provider === "google" || provider === "google-vertex") return true;
  // OpenRouter realizes priority only for its OpenAI- and Google-family
  // upstreams, which are identifiable only from the model id's prefix.
  if (provider === "openrouter") {
    return model.id.startsWith("openai/") || model.id.startsWith("google/");
  }
  return false;
}
