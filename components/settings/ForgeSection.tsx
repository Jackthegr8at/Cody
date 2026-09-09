"use client";

/**
 * Settings › Code hosts: the GitHub and Gitea servers this Cody talks to.
 *
 * One card per host — kind, base URL, default owner, whether a token is saved
 * — plus the form that adds or edits one, a connection test that names the
 * account the token belongs to, and the choice of which host publishes Cody's
 * own updates.
 *
 * The token follows the convention `ProviderDetail` set for provider keys: the
 * field is a blank password draft, never the saved value, because the server
 * does not return one. A saved credential reads "Saved in Cody" with its last
 * four characters, and leaving the field empty on an edit keeps it.
 */
import { AlertCircle, Check, GitBranch, Loader2, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/field";
import { invalidateSettingsRoutes, setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { dangerButtonStyle, primaryButtonStyle, smallButtonStyle } from "./account-controls";
import { chipStyle, nativeInputStyle, nativeOptionStyle, nativeSelectStyle, NativeSetting } from "./primitives";
import { useSettingsShell } from "./shell-context";

export const FORGE_ROUTE = "/api/forge";
export const FORGE_PANEL_ID = "forge";

const GITHUB_BASE_URL = "https://github.com";

export interface ForgeHostRow {
  id: string;
  kind: "github" | "gitea";
  label: string;
  baseUrl: string;
  apiUrl: string;
  owner: string;
  hasToken: boolean;
  tokenPreview: string | null;
  tokenSource: "stored" | "environment" | null;
  isDefault: boolean;
  builtin: boolean;
}

export interface ForgeUpdateSourceRow {
  hostId: string;
  repo: string;
  image: string;
  isDefault: boolean;
}

export interface ForgePayload {
  hosts: ForgeHostRow[];
  defaultHostId: string | null;
  updateSource: ForgeUpdateSourceRow;
  defaultUpdateSource: { hostId: string; repo: string; image: string };
}

interface TestResult {
  ok: boolean;
  login?: string;
  name?: string | null;
  serverVersion?: string | null;
  error?: string;
}

const cardStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 10,
  padding: "12px 14px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-panel)",
  minWidth: 0,
};

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <div role="alert" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--status-error)" }}>
      <AlertCircle size={13} aria-hidden="true" />
      {children}
    </div>
  );
}

async function writeForge(body: unknown): Promise<ForgePayload> {
  const response = await fetch(FORGE_ROUTE, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(formatApiError(payload));
  return payload as ForgePayload;
}

// ── Add / edit form ──────────────────────────────────────────────────────────

interface HostDraft {
  id?: string;
  kind: "github" | "gitea";
  label: string;
  baseUrl: string;
  owner: string;
  token: string;
}

function HostForm({ draft, existing, onCancel, onSaved }: {
  draft: HostDraft;
  /** The saved host this form edits, or null when it creates one. */
  existing: ForgeHostRow | null;
  onCancel: () => void;
  onSaved: (payload: ForgePayload) => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState(draft.kind);
  const [label, setLabel] = useState(draft.label);
  const [baseUrl, setBaseUrl] = useState(draft.baseUrl);
  const [owner, setOwner] = useState(draft.owner);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idPrefix = existing ? `forge-edit-${existing.id}` : "forge-new";
  // GitHub's API base is fixed, so its web origin is not a choice.
  const fixedBase = kind === "github";

  const submit = () => {
    setBusy(true);
    setError(null);
    void writeForge({
      host: {
        ...(existing ? { id: existing.id } : {}),
        kind,
        label: label.trim(),
        baseUrl: fixedBase ? GITHUB_BASE_URL : baseUrl.trim(),
        owner: owner.trim(),
        // An empty draft on an edit means "keep what is saved"; on a new host
        // it means "no token yet".
        ...(token.trim() || !existing ? { token: token.trim() } : {}),
      },
    })
      .then(onSaved)
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ ...cardStyle, borderColor: "var(--accent)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <label htmlFor={`${idPrefix}-kind`} style={{ fontSize: 12, fontWeight: 600 }}>{t("forge.field.kind")}</label>
        <select
          id={`${idPrefix}-kind`}
          value={kind}
          onChange={(event) => setKind(event.target.value === "gitea" ? "gitea" : "github")}
          disabled={busy || existing?.builtin === true}
          style={{ ...nativeSelectStyle, alignSelf: "flex-start" }}
        >
          <option value="github" style={nativeOptionStyle}>GitHub</option>
          <option value="gitea" style={nativeOptionStyle}>Gitea</option>
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <label htmlFor={`${idPrefix}-label`} style={{ fontSize: 12, fontWeight: 600 }}>{t("forge.field.label")}</label>
        <input
          id={`${idPrefix}-label`}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={t("forge.field.labelPlaceholder")}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          style={{ ...nativeInputStyle, minWidth: 0 }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <label htmlFor={`${idPrefix}-base`} style={{ fontSize: 12, fontWeight: 600 }}>{t("forge.field.baseUrl")}</label>
        <input
          id={`${idPrefix}-base`}
          value={fixedBase ? GITHUB_BASE_URL : baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://git.example.net"
          disabled={busy || fixedBase}
          autoComplete="off"
          spellCheck={false}
          style={{ ...nativeInputStyle, minWidth: 0, fontFamily: "var(--font-mono)" }}
        />
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {fixedBase ? t("forge.field.baseUrlGitHub") : t("forge.field.baseUrlHint")}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <label htmlFor={`${idPrefix}-owner`} style={{ fontSize: 12, fontWeight: 600 }}>{t("forge.field.owner")}</label>
        <input
          id={`${idPrefix}-owner`}
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          placeholder={t("forge.field.ownerPlaceholder")}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          style={{ ...nativeInputStyle, minWidth: 0 }}
        />
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("forge.field.ownerHint")}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <label htmlFor={`${idPrefix}-token`} style={{ fontSize: 12, fontWeight: 600 }}>{t("forge.field.token")}</label>
        <input
          id={`${idPrefix}-token`}
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={existing?.hasToken ? t("forge.field.tokenReplace") : t("forge.field.tokenPlaceholder")}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          style={{ ...nativeInputStyle, minWidth: 0, fontFamily: "var(--font-mono)" }}
        />
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("forge.field.tokenHint")}</span>
      </div>

      {error && <ErrorLine>{error}</ErrorLine>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="ui-focus-ring"
          onClick={submit}
          disabled={busy || !label.trim() || (!fixedBase && !baseUrl.trim())}
          style={{ ...primaryButtonStyle, opacity: busy || !label.trim() ? 0.6 : 1 }}
        >
          {busy ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
          {t("forge.action.save")}
        </button>
        <button type="button" className="ui-focus-ring" onClick={onCancel} disabled={busy} style={smallButtonStyle}>
          {t("forge.action.cancel")}
        </button>
      </div>
    </div>
  );
}

// ── One host ─────────────────────────────────────────────────────────────────

function HostCard({ host, canEdit, canRemove, onChanged }: {
  host: ForgeHostRow;
  canEdit: boolean;
  canRemove: boolean;
  onChanged: (payload: ForgePayload) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const runTest = () => {
    setTesting(true);
    setTest(null);
    void fetch(`${FORGE_ROUTE}/${encodeURIComponent(host.id)}/test`, { method: "POST" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(formatApiError(payload));
        setTest(payload as TestResult);
      })
      .catch((failure: unknown) => setTest({ ok: false, error: failure instanceof Error ? failure.message : String(failure) }))
      .finally(() => setTesting(false));
  };

  const act = (body: unknown) => {
    setBusy(true);
    setError(null);
    void writeForge(body)
      .then(onChanged)
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(false));
  };

  const remove = () => {
    setBusy(true);
    setError(null);
    void fetch(`${FORGE_ROUTE}?id=${encodeURIComponent(host.id)}`, { method: "DELETE" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(formatApiError(payload));
        onChanged(payload as ForgePayload);
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => {
        setBusy(false);
        setConfirmRemove(false);
      });
  };

  if (editing) {
    return (
      <HostForm
        draft={{ kind: host.kind, label: host.label, baseUrl: host.baseUrl, owner: host.owner, token: "" }}
        existing={host}
        onCancel={() => setEditing(false)}
        onSaved={(payload) => {
          setEditing(false);
          onChanged(payload);
        }}
      />
    );
  }

  const tokenState = host.tokenSource === "stored"
    ? t("forge.token.saved", { preview: host.tokenPreview ?? "" })
    : host.tokenSource === "environment"
      ? t("forge.token.fromEnvironment")
      : t("forge.token.none");

  return (
    <section data-search-id={`forge-host-${host.id}`} style={cardStyle} aria-label={host.label}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <GitBranch size={13} aria-hidden="true" />
        <span style={{ fontSize: 12.5, fontWeight: 650 }}>{host.label}</span>
        <span style={chipStyle}>{host.kind === "gitea" ? "Gitea" : "GitHub"}</span>
        {host.isDefault && (
          <span style={{ ...chipStyle, color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Star size={10} aria-hidden="true" />
            {t("forge.chip.default")}
          </span>
        )}
        <span style={{ ...chipStyle, color: host.hasToken ? "var(--status-success)" : "var(--text-dim)" }}>{tokenState}</span>
      </div>

      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px", margin: 0, fontSize: 11.5, color: "var(--text-muted)" }}>
        <dt style={{ color: "var(--text-dim)" }}>{t("forge.field.baseUrl")}</dt>
        <dd style={{ margin: 0, fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{host.baseUrl}</dd>
        <dt style={{ color: "var(--text-dim)" }}>{t("forge.field.apiUrl")}</dt>
        <dd style={{ margin: 0, fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{host.apiUrl}</dd>
        <dt style={{ color: "var(--text-dim)" }}>{t("forge.field.owner")}</dt>
        <dd style={{ margin: 0 }}>{host.owner || t("forge.owner.none")}</dd>
      </dl>

      {test && (
        test.ok
          ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--status-success)" }}>
              <Check size={13} aria-hidden="true" />
              {test.serverVersion
                ? t("forge.test.okWithVersion", { login: test.login ?? "", version: test.serverVersion })
                : t("forge.test.ok", { login: test.login ?? "" })}
            </div>
          )
          : <ErrorLine>{test.error ?? t("forge.test.failed")}</ErrorLine>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="ui-focus-ring" onClick={runTest} disabled={testing} style={smallButtonStyle}>
          {testing ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          {t("forge.action.test")}
        </button>
        {canEdit && (
          <button type="button" className="ui-focus-ring" onClick={() => setEditing(true)} disabled={busy} style={smallButtonStyle}>
            {t("forge.action.edit")}
          </button>
        )}
        {canEdit && !host.isDefault && (
          <button type="button" className="ui-focus-ring" onClick={() => act({ defaultHostId: host.id })} disabled={busy} style={smallButtonStyle}>
            <Star size={13} aria-hidden="true" />
            {t("forge.action.setDefault")}
          </button>
        )}
        {canEdit && canRemove && !host.builtin && (
          <button type="button" className="ui-focus-ring" onClick={() => setConfirmRemove(true)} disabled={busy} style={dangerButtonStyle}>
            <Trash2 size={13} aria-hidden="true" />
            {t("forge.action.remove")}
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={(open) => { if (!open) setConfirmRemove(false); }}
        title={t("forge.remove.title", { label: host.label })}
        description={t("forge.remove.description")}
        confirmLabel={t("forge.action.remove")}
        cancelLabel={t("forge.action.cancel")}
        danger
        busy={busy}
        onConfirm={remove}
      />
    </section>
  );
}

// ── Cody's own update source ────────────────────────────────────────────────

function UpdateSourceCard({ payload, canEdit, onChanged }: {
  payload: ForgePayload;
  canEdit: boolean;
  onChanged: (payload: ForgePayload) => void;
}) {
  const { t } = useI18n();
  const [hostId, setHostId] = useState(payload.updateSource.hostId);
  const [repo, setRepo] = useState(payload.updateSource.repo);
  const [image, setImage] = useState(payload.updateSource.image);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const write = (body: unknown) => {
    setBusy(true);
    setError(null);
    void writeForge(body)
      .then((next) => {
        setHostId(next.updateSource.hostId);
        setRepo(next.updateSource.repo);
        setImage(next.updateSource.image);
        onChanged(next);
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <NativeSetting
      label={t("forge.updateSource.title")}
      description={t("forge.updateSource.description")}
      scope="Cody only"
      searchId="cody-update-source"
      badge={payload.updateSource.isDefault ? t("forge.updateSource.defaultBadge") : undefined}
      control={
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select
              aria-label={t("forge.updateSource.host")}
              value={hostId}
              onChange={(event) => setHostId(event.target.value)}
              disabled={!canEdit || busy}
              style={nativeSelectStyle}
            >
              {payload.hosts.map((host) => (
                <option key={host.id} value={host.id} style={nativeOptionStyle}>{host.label}</option>
              ))}
            </select>
            <input
              aria-label={t("forge.updateSource.repo")}
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="owner/name"
              disabled={!canEdit || busy}
              autoComplete="off"
              spellCheck={false}
              style={{ ...nativeInputStyle, flex: "1 1 160px", minWidth: 0, fontFamily: "var(--font-mono)" }}
            />
          </div>
          <input
            aria-label={t("forge.updateSource.image")}
            value={image}
            onChange={(event) => setImage(event.target.value)}
            placeholder="registry.example.net/owner/cody:latest"
            disabled={!canEdit || busy}
            autoComplete="off"
            spellCheck={false}
            style={{ ...nativeInputStyle, minWidth: 0, fontFamily: "var(--font-mono)" }}
          />
          {error && <ErrorLine>{error}</ErrorLine>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="ui-focus-ring"
              onClick={() => write({ codyUpdateSource: { hostId, repo, image } })}
              disabled={!canEdit || busy || !repo.trim()}
              style={{ ...primaryButtonStyle, opacity: !canEdit || busy || !repo.trim() ? 0.6 : 1 }}
            >
              {busy ? <Loader2 size={13} className="icon-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
              {t("forge.action.save")}
            </button>
            {!payload.updateSource.isDefault && (
              <button type="button" className="ui-focus-ring" onClick={() => write({ codyUpdateSource: null })} disabled={!canEdit || busy} style={smallButtonStyle}>
                {t("forge.updateSource.reset")}
              </button>
            )}
          </div>
        </div>
      }
    />
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function ForgeSection() {
  const { t } = useI18n();
  const { callbacks } = useSettingsShell();
  const route = useSettingsRoute<ForgePayload>(FORGE_ROUTE);
  const [adding, setAdding] = useState(false);

  const apply = useCallback((payload: ForgePayload) => {
    setSettingsRouteData(FORGE_ROUTE, payload);
    // The System card reads the update source through its own route.
    invalidateSettingsRoutes("/api/app-update");
  }, []);

  const payload = route.data;
  // Writes are admin-only server-side; the roster read is not, so a member
  // sees the hosts and can test them while the write buttons stay hidden.
  const canEdit = payload !== null && payload.hosts.length > 0 && route.error === null;

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ minWidth: 0 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{t("forge.title")}</h3>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("forge.description")}</p>
      </div>

      {route.loading && !payload && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-muted)" }}>
          <Loader2 size={13} className="icon-spin" aria-hidden="true" />
          {t("forge.loading")}
        </div>
      )}
      {route.error && <ErrorLine>{route.error}</ErrorLine>}

      {payload?.hosts.map((host) => (
        <HostCard
          key={host.id}
          host={host}
          canEdit={canEdit}
          canRemove={payload.hosts.length > 1}
          onChanged={apply}
        />
      ))}

      {adding
        ? (
          <HostForm
            draft={{ kind: "gitea", label: "", baseUrl: "", owner: "", token: "" }}
            existing={null}
            onCancel={() => setAdding(false)}
            onSaved={(next) => {
              setAdding(false);
              apply(next);
            }}
          />
        )
        : (
          <button
            type="button"
            className="ui-focus-ring"
            data-search-id="add-code-host"
            onClick={() => setAdding(true)}
            disabled={!canEdit}
            style={{ ...smallButtonStyle, alignSelf: "flex-start" }}
          >
            <Plus size={13} aria-hidden="true" />
            {t("forge.action.add")}
          </button>
        )}

      {payload && <UpdateSourceCard payload={payload} canEdit={canEdit} onChanged={apply} />}

      <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
        {t("forge.toolNote")}{" "}
        <button
          type="button"
          className="ui-focus-ring"
          onClick={() => callbacks.selectSection("system")}
          style={{ ...smallButtonStyle, minHeight: 0, padding: "0 2px", border: "none", background: "none", color: "var(--accent)" }}
        >
          {t("forge.openSystem")}
        </button>
      </p>
    </div>
  );
}
