"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, Power, PowerOff, RefreshCw, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { fetchSettingsRoute, useSettingsRoute } from "@/hooks/useSettingsData";
import { useI18n } from "@/lib/i18n";
import { MCP_SECRET_SENTINEL } from "@/lib/mcp-secrets";
import { Directory, type DirectoryRow, type DirectorySection, type DirectoryStatus } from "./settings/Directory";
import { Drawer } from "./settings/Drawer";
import { SegmentedControl } from "./settings/SegmentedControl";
import { smallButtonStyle, primaryButtonStyle, dangerButtonStyle } from "./settings/account-controls";
import { chipStyle, nativeInputStyle, SettingsHighlightContext } from "./settings/primitives";

/**
 * Settings › Extensions › MCP: every MCP server the active engine loads, on
 * the shared `Directory` primitive — one section per source the engine
 * reports (user level, project level, discovered; live status when a
 * session is open) — and below it the editor for the two configs Cody can
 * write, chosen with a scope control:
 *
 *   - "This project" — the workspace's own `mcp.json`; workspace-gated.
 *   - "All sessions" — omp's user-level `<agent dir>/mcp.json`, which needs
 *     no workspace at all: a user-level server is exactly what is
 *     configurable without a project. Its path is disclosed once, because a
 *     containerised install relocates the agent dir and the obvious
 *     `~/.omp/mcp.json` is read by nothing.
 *
 * A user-level server's `headers`/`env` values never reach the browser: the
 * route masks each one with `MCP_SECRET_SENTINEL` and merges it back from
 * disk on save (lib/mcp-secrets.ts). The form shows those as bullets, so a
 * credential is never displayed and never blanked by an edit that did not
 * touch it.
 */

export type McpScope = "user" | "project";

type McpServer = { name: string; config: Record<string, unknown> };
// User-level rows carry their config with every credential masked, plus the
// summary fields the route computes (`disabled` is the user file's
// `disabledServers` denylist, which omp honours over any `enabled` flag).
type McpUserServer = { name: string; status: string; type: string; enabled: boolean; disabled?: boolean; valid: boolean; config?: Record<string, unknown> };
type McpUserConfig = { path: string; servers: McpUserServer[]; disabledServers: string[]; error?: string };
type McpLiveStatus = "connected" | "connecting" | "not_connected" | "inactive" | "disabled" | "configured";
type McpLiveServer = { name: string; source: string; status: McpLiveStatus; type?: string };

export interface McpRouteBody {
  servers?: McpServer[];
  user?: McpUserConfig;
  /** False for a signed-in member: user-level servers are instance state, so
   * only an administrator may read their configs or edit them. */
  canManageUser?: boolean;
  inventory?: McpLiveServer[];
  liveServers?: McpLiveServer[];
  liveError?: string;
  path?: string | null;
  error?: string;
}

/** The cache key `useSettingsRoute` reads the MCP inventory under. The
 * search hook uses the cwd-only variant: a `sessionId` makes the route ask
 * the live session, which is not a cached read. */
export function mcpRoute(cwd: string | null, sessionId?: string | null): string {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  if (sessionId) params.set("sessionId", sessionId);
  const query = params.toString();
  return query ? `/api/mcp?${query}` : "/api/mcp";
}

/** Every server the inventory lists, for the dialog-wide search. */
export function mcpInventoryOf(body: McpRouteBody | null | undefined): McpLiveServer[] {
  return body?.liveServers ?? body?.inventory ?? [];
}

const inputStyle = { ...nativeInputStyle, width: "100%", boxSizing: "border-box" as const, font: "12px var(--font-mono)" } as const;

const newServer = () => JSON.stringify({ type: "stdio", command: "", args: [] }, null, 2);

/** What the editor shows where the route masked a credential. Round-tripped
 * back to the sentinel on save, so an untouched secret stays untouched. */
const SECRET_MASK = "••••••••";
const SECRET_FIELDS = ["headers", "env"] as const;

function secretMap(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function swapSecretMarkers(config: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  for (const field of SECRET_FIELDS) {
    const values = secretMap(config[field]);
    if (!values) continue;
    let swapped: Record<string, unknown> | null = null;
    for (const [key, value] of Object.entries(values)) {
      if (value !== from) continue;
      swapped ??= { ...values };
      swapped[key] = to;
    }
    if (!swapped) continue;
    next ??= { ...config };
    next[field] = swapped;
  }
  return next ?? config;
}

function hasMaskedSecret(config: Record<string, unknown>): boolean {
  return SECRET_FIELDS.some((field) => Object.values(secretMap(config[field]) ?? {}).includes(MCP_SECRET_SENTINEL));
}

export function serverSummary(config: Record<string, unknown>): { type: string; target: string; enabled: boolean; valid: boolean } {
  const type = typeof config.type === "string" && config.type !== "stdio" ? config.type : "stdio";
  const command = typeof config.command === "string" ? config.command.trim() : "";
  const url = typeof config.url === "string" ? config.url.trim() : "";
  const hasCommand = command.length > 0;
  const hasUrl = url.length > 0;
  const valid = (hasCommand || hasUrl) && !(hasCommand && hasUrl) && (type === "http" || type === "sse" ? hasUrl : hasCommand);
  return {
    type,
    target: type === "http" || type === "sse" ? url : `${command}${Array.isArray(config.args) ? " " + config.args.join(" ") : ""}`.trim(),
    enabled: config.enabled !== false,
    valid,
  };
}

/** A row title that answers the search highlight (`mcp-<name>`): the row
 * itself belongs to Directory, so the anchor rides on its title. */
function ServerTitle({ name }: { name: string }) {
  const highlightId = useContext(SettingsHighlightContext);
  const ref = useRef<HTMLSpanElement | null>(null);
  const highlighted = highlightId === `mcp-${name}`;
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);
  return (
    <span ref={ref} data-search-id={`mcp-${name}`} style={{ fontFamily: "var(--font-mono)", ...(highlighted ? { color: "var(--accent)" } : {}) }}>{name}</span>
  );
}

/** A section wrapper that answers the search highlight for the list itself. */
function SearchSection({ id, children }: { id: string; children: React.ReactNode }) {
  const highlightId = useContext(SettingsHighlightContext);
  const ref = useRef<HTMLDivElement | null>(null);
  const highlighted = highlightId === id;
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);
  return (
    <div ref={ref} data-search-id={id} style={{ borderRadius: "var(--radius-card)", transition: "box-shadow var(--dur-fast)", ...(highlighted ? { boxShadow: "0 0 0 2px var(--accent)" } : {}) }}>
      {children}
    </div>
  );
}

interface ServerForm {
  /** Which config this form writes. */
  scope: McpScope;
  /** The name the server had when the form opened; null for a new one. */
  previousName: string | null;
  name: string;
  source: string;
  /** The source as opened, so "dirty" survives a masked, reformatted config. */
  initialSource: string;
  /** The opened config carried a masked credential. */
  masked: boolean;
}

export function McpConfig({ cwd, sessionId, initial }: {
  cwd: string | null;
  sessionId?: string | null;
  /** A body to paint until the cache answers (a caller holding a prefetch;
   * the fixture test). */
  initial?: McpRouteBody | null;
}) {
  const { t } = useI18n();
  const route = mcpRoute(cwd, sessionId);
  const { data, error, loading: fetching } = useSettingsRoute<McpRouteBody>(route);
  const body = (data && !data.error ? data : null) ?? initial ?? null;
  const loadError = data?.error ?? error;
  const loading = !body && !loadError;
  const [scope, setScope] = useState<McpScope>(cwd ? "project" : "user");
  const [form, setForm] = useState<ServerForm | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ scope: McpScope; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (loadError) toast.error(t("mcpConfig.loadFailed"), loadError);
  }, [loadError, t]);

  // Losing the workspace (project switch, closed folder) must not leave the
  // editor pointed at a file it can no longer resolve.
  useEffect(() => {
    if (!cwd) setScope("user");
  }, [cwd]);

  const reload = useCallback(() => fetchSettingsRoute<McpRouteBody>(route, { force: true }), [route]);
  // Stable: the Drawer registers a phone level in an effect keyed on its
  // onClose, so an inline arrow here would re-register on every render.
  const closeForm = useCallback(() => { setForm(null); setMessage(null); }, []);

  const servers = useMemo(() => body?.servers ?? [], [body]);
  const userConfig = body?.user ?? null;
  const userServers = useMemo(() => userConfig?.servers ?? [], [userConfig]);
  const displayed = useMemo(() => body ? mcpInventoryOf(body) : null, [body]);
  const activePath = (scope === "project" ? body?.path : userConfig?.path) ?? null;

  const openEditor = (target: McpScope, server: McpServer | null) => {
    setMessage(null);
    const source = server ? JSON.stringify(swapSecretMarkers(server.config, MCP_SECRET_SENTINEL, SECRET_MASK), null, 2) : newServer();
    setForm({
      scope: target,
      previousName: server?.name ?? null,
      name: server?.name ?? "",
      source,
      initialSource: source,
      masked: server ? hasMaskedSecret(server.config) : false,
    });
  };

  const parse = (source: string, target: McpScope): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(source) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("mcpConfig.mustBeObject"));
      // Bullets are a display device; the server only understands the
      // sentinel, and only for the file it masked.
      return target === "user" ? swapSecretMarkers(value as Record<string, unknown>, SECRET_MASK, MCP_SECRET_SENTINEL) : value as Record<string, unknown>;
    } catch (parseError) {
      setMessage(parseError instanceof Error ? parseError.message : t("mcpConfig.invalidJson"));
      return null;
    }
  };

  const check = async () => {
    if (!form) return;
    const server = parse(form.source, form.scope);
    if (!server) return;
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, server }) });
      const result = (await response.json()) as { message?: string; error?: string };
      if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
      setMessage(t("mcpConfig.valid"));
      toast.success(t("mcpConfig.valid"));
    } catch (checkError) {
      const detail = checkError instanceof Error ? checkError.message : String(checkError);
      setMessage(detail);
      toast.error(t("mcpConfig.invalid"), detail);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!form) return;
    const server = parse(form.source, form.scope);
    if (!server) return;
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: form.scope, cwd: form.scope === "project" ? cwd : undefined, name: form.name, previousName: form.previousName ?? undefined, server }),
      });
      const result = (await response.json()) as { error?: string; path?: string };
      if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
      toast.success(t("mcpConfig.savedTitle", { name: form.name }), result.path);
      setForm(null);
      await reload();
    } catch (saveError) {
      const detail = saveError instanceof Error ? saveError.message : String(saveError);
      setMessage(detail);
      toast.error(t("mcpConfig.saveFailed"), detail);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (target: { scope: McpScope; name: string }) => {
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: target.scope, cwd: target.scope === "project" ? cwd : undefined, name: target.name }),
      });
      const result = (await response.json()) as { error?: string; path?: string };
      if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
      toast.success(t("mcpConfig.removedTitle", { name: target.name }), result.path);
      setConfirmRemove(null);
      setForm(null);
      await reload();
    } catch (removeError) {
      const detail = removeError instanceof Error ? removeError.message : String(removeError);
      toast.error(t("mcpConfig.removeFailed"), detail);
    } finally {
      setSaving(false);
    }
  };

  /** omp's denylist lives in the user file and always wins, so enabling and
   * disabling a user-level server is a write to that list, not to the
   * server's own config. */
  const setDisabled = async (name: string, disabled: boolean) => {
    setSaving(true);
    try {
      const response = await fetch("/api/mcp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: disabled ? "disable" : "enable", scope: "user", name }),
      });
      const result = (await response.json()) as { error?: string; path?: string };
      if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
      toast.success(t(disabled ? "mcpConfig.disabledTitle" : "mcpConfig.enabledTitle", { name }), result.path);
      setForm(null);
      await reload();
    } catch (toggleError) {
      const detail = toggleError instanceof Error ? toggleError.message : String(toggleError);
      setMessage(detail);
      toast.error(t("mcpConfig.toggleFailed"), detail);
    } finally {
      setSaving(false);
    }
  };

  const liveStatus = useCallback((status: McpLiveStatus): DirectoryStatus => ({
    tone: status === "connected" ? "ok" : "muted",
    text: t(`mcpConfig.live.${status}`),
  }), [t]);

  // One section per source the engine reports (live status when a session
  // answered, the static inventory otherwise); without either, the
  // user-level file's own rows.
  const configuredSections: DirectorySection[] = useMemo(() => {
    if (displayed) {
      const sources = Array.from(new Set(displayed.map((server) => server.source)));
      const sections = sources.map((sourceName) => ({
        id: `source-${sourceName}`,
        title: sourceName,
        rows: displayed.filter((server) => server.source === sourceName).map((server): DirectoryRow => ({
          id: `${sourceName}:${server.name}`,
          title: <ServerTitle name={server.name} />,
          status: liveStatus(server.status),
          trailing: server.type ? <span style={chipStyle}>{server.type}</span> : undefined,
        })),
      }));
      return sections.length > 0 ? sections : [{ id: "configured-empty", rows: [], empty: loading ? t("mcpConfig.loading") : t("mcpConfig.noneConfigured") }];
    }
    const rows: DirectoryRow[] = [
      ...userServers.map((server): DirectoryRow => ({
        id: `user:${server.name}`,
        title: <ServerTitle name={server.name} />,
        status: server.valid ? (server.enabled ? { tone: "ok", text: t("mcpConfig.statusEnabled") } : { tone: "muted", text: t("mcpConfig.statusDisabled") }) : { tone: "warn", text: t("mcpConfig.statusInvalid") },
        trailing: <span style={chipStyle}>{server.type}</span>,
      })),
      ...(userConfig?.disabledServers ?? []).filter((name) => !userServers.some((server) => server.name === name)).map((name): DirectoryRow => ({
        id: `disabled:${name}`,
        title: <ServerTitle name={name} />,
        status: { tone: "muted", text: t("mcpConfig.statusDisabled") },
      })),
    ];
    return [{ id: "user-level", title: t("mcpConfig.userLevel"), rows, empty: loading ? t("mcpConfig.loading") : userConfig?.error ? userConfig.error : t("mcpConfig.noUserServers") }];
  }, [displayed, userConfig, userServers, loading, liveStatus, t]);

  const projectRows: DirectoryRow[] = servers.map((server) => {
    const summary = serverSummary(server.config);
    return {
      id: `project:${server.name}`,
      title: <ServerTitle name={server.name} />,
      subtitle: summary.target || undefined,
      status: summary.valid ? (summary.enabled ? { tone: "ok", text: summary.type } : { tone: "muted", text: `${summary.type} · ${t("mcpConfig.statusOff")}` }) : { tone: "warn", text: t("mcpConfig.statusInvalid") },
      onOpen: () => openEditor("project", server),
    };
  });

  const userRows: DirectoryRow[] = userServers.map((server) => {
    const summary = server.config ? serverSummary(server.config) : null;
    return {
      id: `user:${server.name}`,
      title: <ServerTitle name={server.name} />,
      subtitle: summary?.target || undefined,
      status: !server.valid ? { tone: "warn", text: t("mcpConfig.statusInvalid") }
        : server.enabled ? { tone: "ok", text: server.type }
        : { tone: "muted", text: `${server.type} · ${t("mcpConfig.statusDisabled")}` },
      // A row without a config came from a route that predates user-level
      // editing; list it rather than open a form on nothing.
      onOpen: server.config ? () => openEditor("user", { name: server.name, config: server.config as Record<string, unknown> }) : undefined,
    };
  });

  const editable = scope === "project" ? servers.map((server) => serverSummary(server.config)) : userServers.map((server) => ({ enabled: server.enabled, valid: server.valid }));
  const enabledCount = editable.filter((server) => server.enabled && server.valid).length;
  const invalidCount = editable.filter((server) => !server.valid).length;
  // The route refuses a member's user-level write; don't offer the button.
  const canManageUser = body?.canManageUser !== false;
  const canAdd = scope === "user" ? canManageUser : cwd !== null;

  const editedUser = form?.previousName && form.scope === "user" ? userServers.find((server) => server.name === form.previousName) ?? null : null;
  const dirty = form !== null && (form.name !== (form.previousName ?? "") || form.source !== form.initialSource);

  return (
    <>
      <SearchSection id="configured-mcp-servers">
        <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden", background: "var(--bg-panel)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
            <strong style={{ fontSize: 12, color: "var(--text)", flexShrink: 0 }}>{t("mcpConfig.inventoryTitle")}</strong>
            <button type="button" title={t("mcpConfig.refresh")} aria-label={t("mcpConfig.refresh")} onClick={() => void reload()} disabled={fetching} style={{ marginLeft: "auto", padding: 6, border: "none", background: "transparent", color: "var(--text-muted)", cursor: fetching ? "wait" : "pointer", display: "inline-flex" }}><RefreshCw size={14} aria-hidden="true" /></button>
          </div>
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {body?.liveError && <div role="status" style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("mcpConfig.liveUnavailable", { error: body.liveError })}</div>}
            <Directory sections={configuredSections} ariaLabel={t("mcpConfig.inventoryTitle")} />
          </div>
        </section>
      </SearchSection>

      <SearchSection id="mcp-servers">
        <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden", background: "var(--bg-panel)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 12, color: "var(--text)", flexShrink: 0 }}>{t("mcpConfig.editorTitle")}</strong>
            <SegmentedControl
              label={t("mcpConfig.scopeLabel")}
              value={scope}
              onChange={(id) => setScope(id as McpScope)}
              idPrefix="mcp-scope"
              panelIdPrefix="mcp-scope-panel"
              options={[
                { id: "project", label: t("mcpConfig.scopeProject") },
                { id: "user", label: t("mcpConfig.scopeUser") },
              ]}
            />
            <code title={activePath ?? undefined} style={{ flex: "1 1 160px", minWidth: 0, color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {scope === "user" ? `${t("mcpConfig.userLevel")}: ` : ""}{activePath ?? (loading ? t("mcpConfig.loading") : t("mcpConfig.unavailable"))}
            </code>
            {editable.length > 0 && (
              <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{t("mcpConfig.countEnabled", { enabled: enabledCount, total: editable.length })}{invalidCount > 0 ? t("mcpConfig.countInvalid", { invalid: invalidCount }) : ""}</span>
            )}
            {canAdd && <button type="button" onClick={() => openEditor(scope, null)} style={smallButtonStyle}><Plus size={13} aria-hidden="true" /> {t("mcpConfig.addServer")}</button>}
          </div>
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div id="mcp-scope-panel-project" role="tabpanel" aria-labelledby="mcp-scope-project" hidden={scope !== "project"}>
              <Directory sections={[{ id: "project", rows: cwd ? projectRows : [], empty: !cwd ? t("mcpConfig.projectNeedsWorkspace") : loading ? t("mcpConfig.loading") : t("mcpConfig.projectEmpty") }]} ariaLabel={t("mcpConfig.scopeProject")} />
            </div>
            <div id="mcp-scope-panel-user" role="tabpanel" aria-labelledby="mcp-scope-user" hidden={scope !== "user"}>
              <Directory sections={[{ id: "user", rows: userRows, empty: loading ? t("mcpConfig.loading") : userConfig?.error ? userConfig.error : t("mcpConfig.userEmpty") }]} ariaLabel={t("mcpConfig.scopeUser")} />
              {!canManageUser && (
                <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{t("mcpConfig.userAdminOnly")}</p>
              )}
            </div>
            {/* Said once, for both scopes: an omp child reads mcp.json when it
                spawns, so a change lands in the next session, not this one. */}
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{t("mcpConfig.applyNote")}</p>
          </div>
        </section>
      </SearchSection>

      <Drawer
        open={form !== null}
        title={form?.previousName ? t("mcpConfig.editTitle", { name: form.previousName }) : t("mcpConfig.addTitle")}
        presentation="side"
        dirty={dirty}
        onClose={closeForm}
        footer={form && (
          <>
            {form.previousName && (
              <button type="button" onClick={() => setConfirmRemove({ scope: form.scope, name: form.previousName as string })} disabled={saving} style={{ ...dangerButtonStyle, marginRight: "auto" }}>
                <Trash2 size={13} aria-hidden="true" /> {t("mcpConfig.remove")}
              </button>
            )}
            {editedUser && (
              <button type="button" onClick={() => void setDisabled(editedUser.name, !editedUser.disabled)} disabled={saving} style={smallButtonStyle}>
                {editedUser.disabled ? <Power size={13} aria-hidden="true" /> : <PowerOff size={13} aria-hidden="true" />} {t(editedUser.disabled ? "mcpConfig.enable" : "mcpConfig.disable")}
              </button>
            )}
            <button type="button" onClick={() => void check()} disabled={saving} style={smallButtonStyle}><Check size={13} aria-hidden="true" /> {t("mcpConfig.check")}</button>
            <button type="button" onClick={closeForm} disabled={saving} style={smallButtonStyle}>{t("mcpConfig.cancel")}</button>
            <button type="button" onClick={() => void save()} disabled={saving || !form.name.trim() || !dirty} style={{ ...primaryButtonStyle, opacity: saving || !form.name.trim() || !dirty ? 0.6 : 1 }}>{saving ? t("mcpConfig.saving") : t("mcpConfig.save")}</button>
          </>
        )}
      >
        {form && (
          <>
            <label style={{ display: "block", color: "var(--text-muted)", fontSize: 11 }}>
              {t("mcpConfig.name")}
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="filesystem" autoCapitalize="none" spellCheck={false} data-drawer-autofocus style={{ ...inputStyle, marginTop: 4 }} />
            </label>
            <label style={{ display: "block", color: "var(--text-muted)", fontSize: 11 }}>
              {t("mcpConfig.json")}
              <textarea value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} spellCheck={false} style={{ ...inputStyle, minHeight: 200, marginTop: 4, resize: "vertical", lineHeight: 1.45 }} />
            </label>
            {form.masked && <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("mcpConfig.secretMaskNote", { mask: SECRET_MASK })}</div>}
            <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
              {t(form.scope === "user" ? "mcpConfig.writesToUser" : "mcpConfig.writesToProject", { path: (form.scope === "user" ? userConfig?.path : body?.path) ?? "mcp.json" })}
            </div>
            {message && <div role="status" style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.4 }}>{message}</div>}
          </>
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => { if (!open && !saving) setConfirmRemove(null); }}
        title={confirmRemove ? t("mcpConfig.removeTitle", { name: confirmRemove.name }) : t("mcpConfig.removeTitleFallback")}
        description={t(confirmRemove?.scope === "user" ? "mcpConfig.removeUserBody" : "mcpConfig.removeProjectBody")}
        confirmLabel={saving ? t("mcpConfig.removing") : t("mcpConfig.removeConfirm")}
        danger
        busy={saving}
        onConfirm={() => { if (confirmRemove) void remove(confirmRemove); }}
      />
    </>
  );
}
