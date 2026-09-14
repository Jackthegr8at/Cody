import assert from "node:assert/strict";
import test from "node:test";

// A Map-backed sessionStorage must exist before the module is imported: the
// store reads `window.sessionStorage` on every access, never at load time.
const stub = new Map();
globalThis.window = {
  sessionStorage: {
    getItem: (key) => stub.get(key) ?? null,
    setItem: (key, value) => stub.set(key, String(value)),
    removeItem: (key) => stub.delete(key),
  },
};

const { createJiti } = await import("jiti");
const { getDraft, setDraft, clearDraft } = await createJiti(import.meta.url).import("./draft-store.ts");

/** A second module instance has an empty in-memory map: what it can still
 * read is exactly what survived a navigation. */
async function freshInstance() {
  return createJiti(import.meta.url, { moduleCache: false }).import("./draft-store.ts");
}

test("a draft's text survives a fresh module instance; images and files do not", async () => {
  stub.clear();
  setDraft("k", { value: "unsent text", images: [{ data: "abc", mimeType: "image/png" }], files: [] });

  const { getDraft: getFresh } = await freshInstance();
  assert.deepEqual(getFresh("k"), { value: "unsent text", images: [], files: [] });
});

test("clearing, or setting an empty draft, leaves nothing for a fresh instance to restore", async () => {
  stub.clear();
  setDraft("cleared", { value: "a", images: [], files: [] });
  clearDraft("cleared");
  setDraft("emptied", { value: "b", images: [], files: [] });
  setDraft("emptied", { value: "", images: [], files: [] });

  const { getDraft: getFresh } = await freshInstance();
  assert.equal(getFresh("cleared"), null);
  assert.equal(getFresh("emptied"), null);
});

test("an oversized draft stays in memory only", async () => {
  stub.clear();
  const huge = "x".repeat(70 * 1024);
  setDraft("big", { value: huge, images: [], files: [] });
  assert.equal(getDraft("big")?.value, huge);

  const { getDraft: getFresh } = await freshInstance();
  assert.equal(getFresh("big"), null);
});
