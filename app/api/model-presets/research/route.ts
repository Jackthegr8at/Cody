import { NextResponse } from "next/server";
import { requireAdminOrOpenInstance } from "@/lib/auth/http";
import { requireEngine } from "@/lib/engine-guard";
import { resolveRosterModel } from "@/lib/model-plan/derive";
import { plannerCandidates, savedDefaultProvider, suggestedPlanner } from "@/lib/model-plan/planner-candidates";
import { loadRoster } from "@/lib/model-plan/roster";
import { getCurrentRun, startResearchRun, type PresetBrief } from "@/lib/model-presets/research";
import { getPreset } from "@/lib/model-presets/store";
import type { ResearchStateResponse } from "@/lib/model-presets/types";
import { readModelRoles } from "@/lib/omp/model-roles";

export const dynamic = "force-dynamic";

/**
 * The researched-preset planner reads OMP's live registry and spawns an omp
 * child to do the research (lib/model-presets/research.ts). Under another
 * engine there is no registry to read and no binary that would honor the
 * selectors a run produced.
 */
const SURFACE = "The researched-preset planner";

export async function GET() {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;

    const roster = await loadRoster();
    const { roles } = readModelRoles();
    const candidates = plannerCandidates(roster.models);
    const preferredProvider = savedDefaultProvider(roles.default, roster.models);
    const suggested = suggestedPlanner(roles.default, candidates, preferredProvider);

    const response: ResearchStateResponse = {
      run: getCurrentRun(),
      plannerCandidates: candidates.map((model) => ({
        selector: model.selector,
        label: model.name,
        provider: model.provider,
      })),
      suggested: suggested?.selector ?? null,
    };
    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    const denied = requireAdminOrOpenInstance(request);
    if (denied) return denied;

    const body = await request.json().catch(() => ({})) as { plannerModel?: unknown; presetIds?: unknown };
    const plannerModel = typeof body.plannerModel === "string" ? body.plannerModel.trim() : "";
    if (!plannerModel) {
      return NextResponse.json({ error: "plannerModel is required" }, { status: 400 });
    }
    const presetIds = Array.isArray(body.presetIds)
      ? body.presetIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())
      : [];
    if (presetIds.length === 0) {
      return NextResponse.json({ error: "presetIds must include at least one preset" }, { status: 400 });
    }

    const roster = await loadRoster();
    if (!resolveRosterModel(plannerModel, roster.models)) {
      return NextResponse.json({ error: `"${plannerModel}" is not an available model` }, { status: 400 });
    }

    const presets: PresetBrief[] = [];
    for (const id of presetIds) {
      const preset = getPreset(id);
      if (!preset) {
        return NextResponse.json({ error: `Unknown preset "${id}"`, code: "not_found" }, { status: 400 });
      }
      presets.push({ id: preset.id, name: preset.name, intent: preset.intent });
    }

    const started = startResearchRun({ plannerModel, presetIds, presets, roster });
    if (!started.ok) {
      if (started.code === "research_running") {
        return NextResponse.json(
          { error: "A research run is already in progress", code: "research_running", run: started.run },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: started.message }, { status: 400 });
    }

    return NextResponse.json({ run: started.run }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
