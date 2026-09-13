import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { getRequestUser, isAuthRequired } from "@/lib/auth/guard";
import { getContextCandidates } from "@/lib/direct-chat/service";
import { readPromptAssetInventory } from "@/lib/prompt-asset-index";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { discoverSkills } from "@/lib/skills-service";
import type { DirectChatPromptAsset } from "@/lib/direct-chat/types";

export const dynamic = "force-dynamic";
const MAX_ASSET_BYTES = 24 * 1024;

function guard(request: Request): NextResponse | null {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  if (isAuthRequired() && !getRequestUser(request)) return NextResponse.json({ error: "Authentication required", code: "auth_required" }, { status: 401 });
  return null;
}
function assetId(filePath: string): string { return createHash("sha256").update(filePath).digest("base64url").slice(0, 24); }

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd || cwd.length > 4096) return NextResponse.json({ error: "A workspace path is required." }, { status: 400 });
  try {
    await getContextCandidates(cwd);
    const discovered = await discoverSkills(cwd);
    const skills = discovered.skills.map((skill) => ({ skill, id: assetId(skill.filePath) }));
    const pluginCommands = readPromptAssetInventory(cwd);
    const selected = url.searchParams.get("asset");
    if (selected) {
      const plugin = pluginCommands.find((candidate) => candidate.id === selected);
      if (plugin) return NextResponse.json({ asset: { ...plugin, kind: "plugin-command" } satisfies DirectChatPromptAsset }, { headers: { "Cache-Control": "no-store" } });
      const skill = skills.find((candidate) => candidate.id === selected);
      if (!skill) return NextResponse.json({ error: "Prompt asset not found." }, { status: 404 });
      const content = readFileSync(skill.skill.filePath, "utf8");
      if (Buffer.byteLength(content) > MAX_ASSET_BYTES) return NextResponse.json({ error: "Prompt asset exceeds the direct-chat limit." }, { status: 413 });
      return NextResponse.json({ asset: { id: skill.id, name: skill.skill.name, description: skill.skill.description, content, enabled: !skill.skill.disableModelInvocation, kind: "skill" } satisfies DirectChatPromptAsset }, { headers: { "Cache-Control": "no-store" } });
    }
    const assetList: DirectChatPromptAsset[] = skills.map(({ skill, id }) => ({ id, name: skill.name, description: skill.description, enabled: !skill.disableModelInvocation, kind: "skill" }));
    return NextResponse.json({ skills: assetList, pluginCommands: pluginCommands.map((asset) => ({ id: asset.id, name: asset.name, description: asset.description, enabled: asset.enabled, kind: "plugin-command" as const })) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Unable to read prompt assets." }, { status: 400 });
  }
}
