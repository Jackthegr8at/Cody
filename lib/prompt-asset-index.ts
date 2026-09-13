import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@/lib/omp/paths";
import type { PluginPackageInfo } from "@/lib/api-types";

const FILE_NAME = "cody-direct-prompt-assets.json";
const MAX_CONTENT_BYTES = 24 * 1024;

export interface StoredPromptAsset {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
}
interface PromptAssetFile { version: 1; workspaces: Record<string, { pluginCommands: StoredPromptAsset[] }> }

function workspaceKey(cwd: string): string { return createHash("sha256").update(path.resolve(cwd)).digest("base64url").slice(0, 24); }
function filePath(): string { return path.join(getAgentDir(), FILE_NAME); }
function readIndex(): PromptAssetFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "workspaces" in parsed && typeof parsed.workspaces === "object" && parsed.workspaces) return parsed as PromptAssetFile;
  } catch { /* absent/corrupt inventory means no cached prompt commands */ }
  return { version: 1, workspaces: {} };
}
function writeIndex(index: PromptAssetFile): void {
  const target = filePath();
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(index)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

export function readPromptAssetInventory(cwd: string): StoredPromptAsset[] {
  return [...(readIndex().workspaces[workspaceKey(cwd)]?.pluginCommands ?? [])];
}

/** Called only by the explicit plugin-management list flow after its CLI metadata refresh. */
export function refreshPromptAssetInventory(cwd: string, packages: PluginPackageInfo[]): void {
  const commands: StoredPromptAsset[] = [];
  for (const plugin of packages) {
    // A feature-filtered plugin does not expose an authoritative command set.
    // Keep it out rather than accidentally surfacing a disabled prompt feature.
    if (plugin.disabled || plugin.filtered) continue;
    for (const resource of plugin.resources) {
      if (resource.kind !== "prompt" || !plugin.installedPath) continue;
      let resourcePath: string;
      let pluginRoot: string;
      try {
        resourcePath = realpathSync(resource.path);
        pluginRoot = realpathSync(plugin.installedPath);
      } catch { continue; }
      if (!resourcePath.startsWith(`${pluginRoot}${path.sep}`)) continue;
      let content: string;
      try { content = readFileSync(resourcePath, "utf8"); } catch { continue; }
      if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) continue;
      commands.push({
        id: createHash("sha256").update(`${plugin.source}\0${resource.relativePath}`).digest("base64url").slice(0, 24),
        name: resource.name,
        description: `Prompt command from ${plugin.source}`,
        content,
        enabled: !plugin.disabled,
      });
    }
  }
  const index = readIndex();
  index.workspaces[workspaceKey(cwd)] = { pluginCommands: commands };
  writeIndex(index);
}
