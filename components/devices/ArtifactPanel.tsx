"use client";

import { Copy, Download, FileDown, FileUp, FolderInput, Trash2, TriangleAlert, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { useI18n } from "@/lib/i18n";
import { deviceArtifacts, type DeviceArtifact, type DeviceArtifactSource } from "@/lib/devices/artifacts";

interface ArtifactPanelProps {
  sessionId: string;
  selectedInputId: string | null;
  onSelectInput(id: string | null): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function actionStyle(disabled = false): React.CSSProperties {
  return {
    height: 24,
    padding: "0 7px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    background: "var(--bg-panel)",
    color: disabled ? "var(--text-dim)" : "var(--text)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 11,
    fontWeight: 600,
    opacity: disabled ? 0.6 : 1,
  };
}

function sourceLabel(source: DeviceArtifactSource, t: (key: string) => string): string {
  switch (source) {
    case "picker": return t("devices.artifactSourcePicker");
    case "drop": return t("devices.artifactSourceDrop");
    case "server-file": return t("devices.artifactSourceServer");
    case "device": return t("devices.artifactSourceDevice");
  }
}

/** Session-owned firmware and dump bytes. It deliberately has no remote URL
 * input: server-local paths are fetched only through the existing guarded API. */
export function ArtifactPanel({ sessionId, selectedInputId, onSelectInput }: ArtifactPanelProps): React.ReactElement {
  const { t } = useI18n();
  const picker = useRef<HTMLInputElement>(null);
  const [artifacts, setArtifacts] = useState<readonly DeviceArtifact[]>(() => deviceArtifacts.list(sessionId));
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = deviceArtifacts.subscribe(sessionId, setArtifacts);
    void deviceArtifacts.hydrate(sessionId).catch((cause: unknown) => {
      if (active) setError(errorText(cause));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [sessionId]);

  useEffect(() => {
    if (selectedInputId && !artifacts.some((artifact) => artifact.id === selectedInputId)) {
      onSelectInput(null);
    }
  }, [artifacts, onSelectInput, selectedInputId]);

  const addFiles = async (files: readonly File[], source: "picker" | "drop") => {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let lastInput: DeviceArtifact | undefined;
      for (const file of files) lastInput = await deviceArtifacts.addInput(sessionId, file, file.name, source);
      if (lastInput) onSelectInput(lastInput.id);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const importLocalPath = async () => {
    setBusy(true);
    setError(null);
    try {
      const artifact = await deviceArtifacts.importAuthorizedFile(sessionId, path);
      onSelectInput(artifact.id);
      setPath("");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t("devices.artifacts")} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)" }}>
        {t("devices.artifacts")}
      </div>
      <div role="note" style={{ fontSize: 10, lineHeight: 1.35, color: "var(--text-muted)" }}>{t("devices.artifactEscrowNotice")}</div>
      <div
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void addFiles(Array.from(event.dataTransfer.files), "drop");
        }}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 7,
          padding: 8,
          border: `1px dashed ${dragging ? "var(--accent)" : "var(--border)"}`,
          borderRadius: "var(--radius-control)",
          background: dragging ? "var(--bg-selected)" : "var(--bg-panel)",
        }}
      >
        <input
          ref={picker}
          type="file"
          hidden
          onChange={(event) => {
            void addFiles(Array.from(event.currentTarget.files ?? []), "picker");
            event.currentTarget.value = "";
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Upload size={14} aria-hidden="true" style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, lineHeight: 1.35, color: "var(--text-muted)" }}>{t("devices.dropFirmware")}</span>
          <button type="button" className="ui-focus-ring" disabled={busy} onClick={() => picker.current?.click()} style={actionStyle(busy)}>
            {t("devices.chooseFile")}
          </button>
        </div>
        <div style={{ display: "flex", gap: 5 }}>
          <label htmlFor="device-local-artifact" className="sr-only">{t("devices.localPath")}</label>
          <input
            id="device-local-artifact"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && path.trim() && !busy) void importLocalPath();
            }}
            placeholder={t("devices.localPathPlaceholder")}
            style={{ minWidth: 0, flex: 1, height: 24, padding: "0 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 11 }}
          />
          <button type="button" className="ui-focus-ring" disabled={busy || !path.trim()} onClick={() => void importLocalPath()} style={actionStyle(busy || !path.trim())}>
            <FolderInput size={12} aria-hidden="true" /> {t("devices.importPath")}
          </button>
        </div>
        <div style={{ fontSize: 10, lineHeight: 1.35, color: "var(--text-dim)" }}>{t("devices.authorizedPathHint")}</div>
      </div>

      {error && (
        <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "6px 7px", border: "1px solid color-mix(in srgb, var(--status-error) 55%, var(--border))", borderRadius: "var(--radius-control)", color: "var(--status-error)", fontSize: 11, lineHeight: 1.35 }}>
          <TriangleAlert size={12} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}

      {artifacts.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("devices.artifactsEmpty")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {artifacts.map((artifact) => {
            const selected = artifact.id === selectedInputId;
            return (
              <div key={artifact.id} style={{ display: "flex", flexDirection: "column", gap: 4, padding: 7, border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`, borderRadius: "var(--radius-control)", background: selected ? "var(--bg-selected)" : "var(--bg-panel)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {artifact.kind === "input" ? <FileUp size={13} aria-hidden="true" /> : <FileDown size={13} aria-hidden="true" />}
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 11, fontWeight: 600 }} title={artifact.name}>{artifact.name}</span>
                  <button type="button" className="ui-focus-ring" aria-pressed={selected} onClick={() => onSelectInput(selected ? null : artifact.id)} style={actionStyle()}>
                    {selected ? t("devices.inputSelected") : t("devices.useInput")}
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 10, lineHeight: 1.3, color: "var(--text-muted)" }}>
                  <span>{artifact.kind === "input" ? t("devices.artifactInput") : t("devices.artifactOutput")} · {sourceLabel(artifact.source, t)} · {formatBytes(artifact.size)}</span>
                  <code style={{ overflowWrap: "anywhere", color: "var(--text-dim)" }}>{artifact.id}</code>
                  <code style={{ overflowWrap: "anywhere", color: "var(--text-dim)" }}>{artifact.sha256}</code>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 5 }}>
                  <button type="button" className="ui-focus-ring" onClick={() => { if (!navigator.clipboard) { setError(t("devices.clipboardUnavailable")); return; } void navigator.clipboard.writeText(artifact.id + "\n" + artifact.sha256).then(() => setError(null)).catch((caught: unknown) => setError(errorText(caught))); }} style={actionStyle()}><Copy size={12} aria-hidden="true" /> {t("devices.copyArtifactReference")}</button>
                  <button type="button" className="ui-focus-ring" onClick={() => deviceArtifacts.download(sessionId, artifact.id)} style={actionStyle()}><Download size={12} aria-hidden="true" /> {t("devices.downloadArtifact")}</button>
                  <button type="button" className="ui-focus-ring" onClick={() => { void deviceArtifacts.remove(sessionId, artifact.id).then((removed) => { if (removed && selected) onSelectInput(null); }).catch((cause: unknown) => setError(errorText(cause))); }} style={actionStyle()}><Trash2 size={12} aria-hidden="true" /> {t("devices.removeArtifact")}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
