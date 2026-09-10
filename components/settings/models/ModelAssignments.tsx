"use client";

/**
 * Settings › Models › Assignments: which model plays each role, what
 * happens when one fails, the planner that proposes both, and Cody's own
 * Distill chain. Four views behind one segmented control so a long
 * fallback-chain editor never pushes the roles off screen.
 *
 * The role and chain pickers offer the models that reach sessions AND are
 * visible to this user; a role already on a hidden model is flagged in
 * `ModelRoles` rather than silently re-pointed.
 *
 * The first three views are the ENGINE's config (`capabilities.models`);
 * Distill is Cody's own file and rides on its route saying `supported`, so
 * an engine with no roles surface can still have a Distill view and
 * nothing else.
 */
import { useEffect, useState } from "react";
import { useSettingsShell } from "../shell-context";
import type { ModelCatalogHandle } from "@/hooks/useModelCatalog";
import { ModelPlanPanel } from "../ModelPlanPanel";
import { RetryFallbackPanel, type RuntimeModelEntry } from "../RetryFallbackPanel";
import { DistillAssignment } from "./DistillAssignment";
import { ModelRoles, type RoleModelOption } from "./ModelRoles";

type View = "roles" | "retry" | "plan" | "distill";

const VIEWS: { id: View; label: string }[] = [
  { id: "roles", label: "Roles" },
  { id: "retry", label: "Retry & fallback" },
  { id: "plan", label: "Plan" },
  { id: "distill", label: "Distill" },
];

/** The view a jump lands on: the retry keys' schema ids (the Behavior hub
 * trails them here) and the retry panel's own toggle belong to Retry, the
 * Distill card to Distill. Null when the highlight is not a view's own. */
function viewForHighlight(highlight: string | null): View | null {
  if (highlight === null) return null;
  if (highlight.startsWith("schema-retry.") || highlight === "retry-transient-errors") return "retry";
  if (highlight === "distill-chain") return "distill";
  return null;
}

export function ModelAssignments({ catalog, panelId, engineViews, distillView }: { catalog: ModelCatalogHandle; panelId: string; engineViews: boolean; distillView: boolean }) {
  const { highlight } = useSettingsShell();
  const [view, setView] = useState<View>(viewForHighlight(highlight) ?? "roles");
  // A jump to a setting (search result, "Also under" chip) must land on the
  // view that renders it, whichever view was open before.
  useEffect(() => {
    const target = viewForHighlight(highlight);
    if (target) setView(target);
  }, [highlight]);

  // Distill appears the moment its route says the engine supports it, so
  // the segmented control can be a single tab on an engine with no roles.
  const views = VIEWS.filter((entry) => (entry.id === "distill" ? distillView : engineViews));
  const active = views.some((entry) => entry.id === view) ? view : views[0]?.id ?? null;

  const roleOptions: RoleModelOption[] = catalog.rows
    .filter((row) => row.source === "catalog")
    .map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      ...(row.thinkingLevels ? { thinkingLevels: row.thinkingLevels } : {}),
      ...(row.state === "instanceHidden" || row.state === "myHidden" ? { hidden: true } : {}),
    }));
  const visibleModels: RuntimeModelEntry[] = roleOptions.filter((model) => !model.hidden);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      {views.length > 1 && (
        <div role="tablist" aria-label="Assignments" style={{ display: "inline-flex", gap: 2, padding: 3, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", alignSelf: "flex-start", maxWidth: "100%", overflowX: "auto" }}>
          {views.map((entry) => {
            const selected = entry.id === active;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`settings-assignments-${entry.id}`}
                aria-selected={selected}
                onClick={() => setView(entry.id)}
                className="ui-focus-ring"
                style={{ padding: "5px 12px", minHeight: 30, border: "none", borderRadius: "calc(var(--radius-control) - 2px)", background: selected ? "var(--bg-selected)" : "transparent", color: selected ? "var(--text)" : "var(--text-muted)", fontSize: 12, fontWeight: selected ? 600 : 500, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      )}
      {active === "roles" && <ModelRoles models={roleOptions} panelId={panelId} />}
      {active === "retry" && <RetryFallbackPanel models={visibleModels} panelId={panelId} onOpenModelPlan={() => setView("plan")} />}
      {active === "plan" && <ModelPlanPanel />}
      {active === "distill" && <DistillAssignment models={roleOptions} panelId={panelId} />}
    </div>
  );
}
