export interface ChatDraftImage {
  data: string;
  mimeType: string;
  /** Original file name, kept so a restored draft can still name an
   *  over-budget attachment in the error that blocks the send. */
  name?: string;
}

export interface ChatDraftFile {
  name: string;
  mimeType: string;
  content: string;
  size: number;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  files: ChatDraftFile[];
}

/** Only the TEXT of a draft is mirrored into sessionStorage so it survives a
 * reload or navigation; images and files can be megabytes and stay in memory.
 * Every storage call is best-effort: no window (SSR, tests), a disabled
 * storage, or a full quota must never break the composer. */
const DRAFT_PREFIX = "cody:draft:";
/** UTF-16 units; a draft past this is kept in memory only. */
const DRAFT_VALUE_LIMIT = 64 * 1024;

function readStoredValue(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage.getItem(DRAFT_PREFIX + key);
  } catch {
    return null;
  }
}

function writeStoredValue(key: string, value: string): void {
  try {
    if (typeof window === "undefined") return;
    if (value && value.length <= DRAFT_VALUE_LIMIT) window.sessionStorage.setItem(DRAFT_PREFIX + key, value);
    else window.sessionStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    // Quota exceeded or storage disabled: the in-memory draft still works.
  }
}

const drafts = new Map<string, ChatDraft>();

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    files: draft.files.map((file) => ({ ...file })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && draft.files.length === 0;
}


export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  if (draft) return cloneDraft(draft);
  const stored = readStoredValue(key);
  return stored ? { value: stored, images: [], files: [] } : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    clearDraft(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
  writeStoredValue(key, draft.value);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  writeStoredValue(key, "");
}
