import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { applyPriceFillPlan, planPriceFill } = await jiti.import("./model-price-fill.ts");

const NOW = new Date("2026-09-25T03:00:00.000Z");
const devEntry = (providerId, id, cost) => ({ key: `${providerId}/${id}`, providerId, providerName: providerId, id, name: id, cost });
const MODELS_DEV = [
  devEntry("openai", "gpt-6-luna", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }),
  devEntry("openrouter", "openai/gpt-6-nova", { input: 3, output: 12 }),
  devEntry("openrouter", "free/model", { input: 0, output: 0 }),
];

function inputs(overrides = {}) {
  const bundled = new Set(overrides.bundled ?? []);
  const yml = overrides.yml ?? {};
  return {
    catalog: overrides.catalog ?? [],
    isBundled: (provider, id) => bundled.has(`${provider}/${id}`),
    modelsDev: (provider, id) => (overrides.modelsDev ?? MODELS_DEV).find((entry) => entry.providerId === provider && entry.id === id),
    currentOverride: (provider, id) => yml[`${provider}/${id}`],
    ledger: overrides.ledger ?? {},
    now: NOW,
  };
}

// The case this exists for: a GPT a ChatGPT subscription lists before omp's
// catalog knows it is priced at zero, and every turn on it reads as free.
test("an unpriced model omp does not list gets models.dev's rate, through a declared alias", () => {
  const plan = planPriceFill(inputs({ catalog: [{ provider: "openai-codex", id: "gpt-6-luna", unpriced: true }] }));
  assert.deepEqual(plan.set, [{
    provider: "openai-codex", modelId: "gpt-6-luna",
    cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    source: "models.dev:openai/gpt-6-luna",
  }]);
  assert.ok(plan.ledger["openai-codex/gpt-6-luna"]);
});

test("omp's own answer, a price already in models.yml, and a free models.dev entry are all left alone", () => {
  const plan = planPriceFill(inputs({
    catalog: [
      // omp's catalog lists it at zero: a deliberate zero (prepaid plan, free tier).
      { provider: "openai-codex", id: "gpt-6-luna", unpriced: true },
      // omp already has a price for it.
      { provider: "openrouter", id: "openai/gpt-6-nova" },
      // models.dev says free: nothing to add.
      { provider: "openrouter", id: "free/model", unpriced: true },
      // a local endpoint models.dev has never heard of.
      { provider: "llama-swap", id: "qwen3-coder", unpriced: true },
    ],
    bundled: ["openai-codex/gpt-6-luna"],
  }));
  assert.deepEqual(plan.set, []);
  const userSet = planPriceFill(inputs({
    catalog: [{ provider: "openrouter", id: "openai/gpt-6-nova", unpriced: true }],
    yml: { "openrouter/openai/gpt-6-nova": { input: 1, output: 1 } },
  }));
  assert.deepEqual(userSet.set, [], "a price the user wrote is never replaced");
});

test("a filled price follows models.dev, and is handed back once omp ships the model", () => {
  const written = { input: 3, output: 12 };
  const ledger = { "openrouter/openai/gpt-6-nova": { provider: "openrouter", modelId: "openai/gpt-6-nova", cost: written, source: "models.dev:openrouter/openai/gpt-6-nova", writtenAt: "2026-09-24T00:00:00.000Z" } };
  const yml = { "openrouter/openai/gpt-6-nova": written };

  const moved = planPriceFill(inputs({ ledger, yml, modelsDev: [devEntry("openrouter", "openai/gpt-6-nova", { input: 2.5, output: 10 })] }));
  assert.deepEqual(moved.set.map((entry) => entry.cost), [{ input: 2.5, output: 10 }]);

  const shipped = planPriceFill(inputs({ ledger, yml, bundled: ["openrouter/openai/gpt-6-nova"] }));
  assert.deepEqual(shipped.remove, [{ provider: "openrouter", modelId: "openai/gpt-6-nova" }]);
  assert.deepEqual(shipped.ledger, {}, "omp prices it now; Cody forgets it");
});

test("once the user edits or removes a filled price, Cody never writes that model again", () => {
  const ledger = { "openrouter/openai/gpt-6-nova": { provider: "openrouter", modelId: "openai/gpt-6-nova", cost: { input: 3, output: 12 }, source: "x", writtenAt: "" } };
  const edited = planPriceFill(inputs({ ledger, yml: { "openrouter/openai/gpt-6-nova": { input: 4, output: 12 } } }));
  assert.deepEqual(edited.set, []);
  assert.equal(edited.ledger["openrouter/openai/gpt-6-nova"].released, true);

  // Removed from models.yml, so omp prices it at zero again: still hands off.
  const removed = planPriceFill(inputs({
    ledger: edited.ledger,
    catalog: [{ provider: "openrouter", id: "openai/gpt-6-nova", unpriced: true }],
  }));
  assert.deepEqual(removed.set, []);
  assert.deepEqual(removed.remove, []);
});

test("applying a plan touches only cost, and a handback leaves the file as it was", () => {
  const original = { providers: {
    openrouter: { modelOverrides: { "openai/gpt-6-nova": { name: "Nova" } } },
    "alibaba-token-plan": { modelOverrides: { "qwen3.8-max": { cost: { input: 2, output: 6 } } } },
  } };
  const set = applyPriceFillPlan(original, { set: [
    { provider: "openrouter", modelId: "openai/gpt-6-nova", cost: { input: 3, output: 12 }, source: "x" },
    { provider: "openai-codex", modelId: "gpt-6-luna", cost: { input: 0.1, output: 0.5 }, source: "x" },
  ], remove: [] });
  assert.deepEqual(set.providers.openrouter.modelOverrides["openai/gpt-6-nova"], { name: "Nova", cost: { input: 3, output: 12 } });
  assert.deepEqual(set.providers["openai-codex"], { modelOverrides: { "gpt-6-luna": { cost: { input: 0.1, output: 0.5 } } } });

  const back = applyPriceFillPlan(set, { set: [], remove: [
    { provider: "openrouter", modelId: "openai/gpt-6-nova" },
    { provider: "openai-codex", modelId: "gpt-6-luna" },
  ] });
  assert.deepEqual(back, original);
});
