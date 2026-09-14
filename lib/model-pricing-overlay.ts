/**
 * Pay-as-you-go prices for models omp's catalog prices at zero.
 *
 * Alibaba's Token Plan is a prepaid credit pool, so the bundled catalog
 * (`@oh-my-pi/pi-catalog`) carries `cost: {input: 0, output: 0, …}` for
 * every `alibaba-token-plan` model. That is defensible for billing and
 * useless for judgement: every Qwen turn, every subagent row and every
 * session total reads as free, so there is no way to see what the work
 * would have cost — or to compare a plan model against a metered one.
 *
 * The fix is applied where it does the most good: omp's `models.yml`
 * supports `providers.<id>.modelOverrides.<model>.cost`, so writing the
 * published rates there makes **omp itself** compute the cost, with the real
 * input/output/cache split, everywhere it already reports one. Cody does not
 * need a parallel estimator, and nothing downstream has to learn a new
 * field.
 *
 * Rates: Alibaba Cloud Model Studio "Model inference pricing",
 * https://www.alibabacloud.com/help/en/model-studio/model-pricing
 * read 2026-09-13. INTERNATIONAL (Singapore) endpoint, standard real-time
 * inference — not the Global endpoint, not the 50% batch rate, and list
 * price rather than a limited-time promotion. Units are USD per 1M tokens,
 * matching the catalog's own convention (anthropic/claude-opus-5 = 5 / 25).
 * For a tiered model the lowest input tier is used: it is the one an
 * ordinary request falls in.
 */

import { readModelsConfigFile, writeModelsConfig, type ModelsFileConfig } from "./omp/models-config";
import { isRecord } from "./type-guards";

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Context-cache hits bill at 10% of the standard input rate. Explicit cache
 * CREATION is 125%, but implicit caching (what an agent actually gets) is
 * not charged separately, so `cacheWrite` stays at the input rate rather
 * than over-reporting a cost the user may never incur. */
function rate(input: number, output: number): ModelCost {
	return { input, output, cacheRead: Number((input * 0.1).toFixed(4)), cacheWrite: input };
}

/**
 * `provider -> modelId -> cost`. Only providers whose catalog entries are
 * deliberately zero-priced belong here.
 *
 * `qwen3.8-max-preview` is intentionally absent: the pricing page does not
 * list it, and a guessed rate is worse than a visibly missing one.
 */
export const PAY_AS_YOU_GO_PRICES: Record<string, Record<string, ModelCost>> = {
	"alibaba-token-plan": {
		"qwen3.8-max": rate(2, 6),
		"qwen3.7-max": rate(2.5, 7.5),
		"qwen3.8-flash": rate(0.15, 0.47),
		// Tiered 0–256K / 256K–1M; the lower tier is the everyday one.
		"qwen3.7-plus": rate(0.4, 1.6),
		"qwen3.6-flash": rate(0.25, 1.5),
		"glm-5.2": rate(1.4, 4.4),
		"deepseek-v4-pro": rate(2.4, 4.8),
	},
};

export interface PricingSeedResult {
	written: string[];
	reason?: string;
}

function existingCost(config: ModelsFileConfig, provider: string, modelId: string): unknown {
	const providerConfig = config.providers?.[provider];
	if (!isRecord(providerConfig)) return undefined;
	const overrides = providerConfig.modelOverrides;
	if (!isRecord(overrides)) return undefined;
	const model = overrides[modelId];
	return isRecord(model) ? model.cost : undefined;
}

/**
 * Write any MISSING price into models.yml. Idempotent, and it never touches
 * a cost the user already set — a rate they corrected by hand must survive
 * every later run.
 */
export function ensurePayAsYouGoPrices(): PricingSeedResult {
	const file = readModelsConfigFile();
	if (file.parseError) return { written: [], reason: file.parseError };
	const providers: Record<string, Record<string, unknown>> = { ...(file.config.providers ?? {}) };
	const written: string[] = [];

	for (const [provider, models] of Object.entries(PAY_AS_YOU_GO_PRICES)) {
		for (const [modelId, cost] of Object.entries(models)) {
			if (existingCost(file.config, provider, modelId) !== undefined) continue;
			const providerConfig = isRecord(providers[provider]) ? { ...providers[provider] } : {};
			const overrides = isRecord(providerConfig.modelOverrides) ? { ...providerConfig.modelOverrides } : {};
			const model = isRecord(overrides[modelId]) ? { ...(overrides[modelId] as Record<string, unknown>) } : {};
			overrides[modelId] = { ...model, cost };
			providerConfig.modelOverrides = overrides;
			providers[provider] = providerConfig;
			written.push(`${provider}/${modelId}`);
		}
	}
	if (written.length === 0) return { written: [] };
	writeModelsConfig({ ...file.config, providers } as ModelsFileConfig);
	return { written };
}

let seeded = false;

/**
 * Seed once per server process, for omp only (models.yml is omp's file).
 * Swallows every failure: a missing agent dir, a read-only mount or a
 * models.yml the user is mid-edit must never cost a caller its catalog.
 */
export function seedPayAsYouGoPricesOnce(engineId: string): void {
	if (seeded || engineId !== "omp") return;
	seeded = true;
	try {
		ensurePayAsYouGoPrices();
	} catch {
		// Prices are an improvement on zero, not a requirement.
	}
}
