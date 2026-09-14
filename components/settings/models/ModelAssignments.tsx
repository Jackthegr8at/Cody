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
import { useEffect, useMemo, useState } from "react";
import { useSettingsShell } from "../shell-context";
import { useI18n } from "@/lib/i18n";
import { setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { SegmentedControl } from "../SegmentedControl";
import { OMP_ENGINE_ID } from "@/components/SettingsTabs";
import { LocalModelProfileCard, type LocalModelProfileBody, type PromptProfileOverride } from "@/components/LocalModelProfile";
import { toast } from "@/components/ui/toast";
import type { ModelCatalogHandle } from "@/hooks/useModelCatalog";
import { ModelPlanPanel } from "../ModelPlanPanel";
import { RetryFallbackPanel, type RuntimeModelEntry } from "../RetryFallbackPanel";
import { DistillAssignment } from "./DistillAssignment";
import { RoutingBindingCard } from "./RoutingBindingCard";
import { ModelRoles, type RoleModelOption } from "./ModelRoles";
import { LocalRoutingAssignment, useLocalRoutingConfig } from "./LocalRoutingAssignment";

type View = "local" | "roles" | "retry" | "plan" | "distill";

const VIEWS: { id: View; label?: string }[] = [
  { id: "local" },
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
  if (highlight === "local-model-prompt-profile") return "local";
  if (highlight === "distill-chain") return "distill";
  return null;
}

export function ModelAssignments({ catalog, panelId, engineViews, distillView }: { catalog: ModelCatalogHandle; panelId: string; engineViews: boolean; distillView: boolean }) {
  const { highlight, engine } = useSettingsShell();
    const { t } = useI18n();
  const [view, setView] = useState<View>(viewForHighlight(highlight) ?? "roles");
  const { available: localRoutingAvailable } = useLocalRoutingConfig(engine?.id === OMP_ENGINE_ID);
  // view that renders it, whichever view was open before.
  useEffect(() => {
    const target = viewForHighlight(highlight);
    if (target) setView(target);
  }, [highlight]);

  // Distill appears the moment its route says the engine supports it, so
  // the segmented control can be a single tab on an engine with no roles.
  const views = VIEWS.filter((entry) => entry.id === "local" ? localRoutingAvailable : entry.id === "distill" ? distillView : engineViews);
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
    const profileModels = useMemo(() => roleOptions.filter((model) => !model.hidden).map(({ provider, id, name }) => ({ provider, id, name })), [roleOptions]);
    const [profileModelKey, setProfileModelKey] = useState("");
    useEffect(() => {
      if (profileModels.some((model) => `${model.provider}/${model.id}` === profileModelKey)) return;
      setProfileModelKey(profileModels[0] ? `${profileModels[0].provider}/${profileModels[0].id}` : "");
    }, [profileModels, profileModelKey]);
  const profileRouteUrl = engine?.id === OMP_ENGINE_ID
    ? profileModelKey
      ? `/api/local-model-profile?provider=${encodeURIComponent(profileModelKey.slice(0, profileModelKey.indexOf("/")))}&modelId=${encodeURIComponent(profileModelKey.slice(profileModelKey.indexOf("/") + 1))}`
      : "/api/local-model-profile"
    : null;
  const profileRoute = useSettingsRoute<LocalModelProfileBody>(profileRouteUrl, { enabled: engine?.id === OMP_ENGINE_ID, ttlMs: 60_000 });
  const [profileSaving, setProfileSaving] = useState(false);
    const saveProfile = (scope: "global" | "model", value: PromptProfileOverride, selected?: { provider: string; modelId: string }) => {
      setProfileSaving(true);
      void (async () => {
        const payload = scope === "global" ? { scope, value } : { scope, value, provider: selected?.provider, modelId: selected?.modelId };
        const response = await fetch("/api/local-model-profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const data = await response.json().catch(() => ({})) as LocalModelProfileBody & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
        const nextData = data.selection ? data : { ...data, ...(profileRoute.data?.selection ? { selection: profileRoute.data.selection } : {}) };
              if (profileRouteUrl) setSettingsRouteData(profileRouteUrl, nextData);
        toast.success(t("localModelProfile.saved"));
      })().catch((error: unknown) => toast.error(t("localModelProfile.saveFailed"), error instanceof Error ? error.message : String(error)))
        .finally(() => setProfileSaving(false));
    };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      {views.length > 1 && (
        <SegmentedControl
          label="Assignments"
          value={active}
          options={views.map((entry) => ({
            id: entry.id,
            label: entry.id === "local" ? t("localRouting.title") : entry.label,
          }))}
          onChange={(value) => setView(value as View)}
          idPrefix="settings-assignments"
          panelIdPrefix="settings-subpanel"
        />
      )}
      {active === "local" && <LocalRoutingAssignment panelId={panelId} />}
      {profileRoute.data && active === "local" && (
        <details style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", padding: "10px 12px" }}>
          <summary style={{ cursor: "pointer", color: "var(--text)", fontSize: 12.5, fontWeight: 600 }}>
            {t("localModelProfile.advanced")}
          </summary>
          <p style={{ margin: "8px 0 10px", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
            {t("localModelProfile.advancedHint")}
          </p>
          <LocalModelProfileCard
            body={profileRoute.data}
            models={profileModels}
            selectedModelKey={profileModelKey}
            onSelectedModelKeyChange={setProfileModelKey}
            saving={profileSaving}
            onChange={saveProfile}
          />
        </details>
      )}
            {active === "roles" && <ModelRoles models={roleOptions} panelId={panelId} />}
      {active === "retry" && engine?.id === OMP_ENGINE_ID && <RoutingBindingCard />}
      {active === "retry" && <RetryFallbackPanel models={visibleModels} panelId={panelId} onOpenModelPlan={() => setView("plan")} />}
      {active === "plan" && <ModelPlanPanel />}
      {active === "distill" && <DistillAssignment models={roleOptions} panelId={panelId} />}
    </div>
  );
}
