import { matchesGlob } from "node:path";
import {
  readModelsConfig,
  type ModelDefinition,
  type ModelsFileConfig,
  type ProviderConfig,
} from "@/lib/omp/models-config";
import { readNativeSettings } from "@/lib/omp/settings-config";

/** Static custom model endpoint metadata. This is intentionally read-only and never invokes a harness process or catalog refresh. */
export function readConfiguredDirectModels(): ModelsFileConfig {
  return readModelsConfig();
}

/** OMP resolves enabledModels against provider-qualified and bare ids. Node native glob matching preserves the pathname rule: * stays within a segment while ** crosses /. */
export function matchesEnabledModel(pattern: string, provider: string, modelId: string): boolean {
  return matchesGlob(provider + "/" + modelId, pattern) || !pattern.includes("/") && matchesGlob(modelId, pattern);
}

export function readDirectModelCuration(): { enabledModels?: string[]; disabledProviders: Set<string> } {
  const settings = readNativeSettings().settings;
  return { enabledModels: settings.enabledModels, disabledProviders: new Set(settings.disabledProviders ?? []) };
}

export type { ModelDefinition, ProviderConfig };
