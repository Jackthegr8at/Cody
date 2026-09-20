import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceArtifactError, DeviceArtifactStore, authorizedArtifactDownloadUrl } = await jiti.import("./artifacts.ts");

test("artifact escrow fails closed when this runtime has no IndexedDB", { skip: typeof indexedDB !== "undefined" }, async () => {
  const store = new DeviceArtifactStore();
  await assert.rejects(
    () => store.save("session-a", "flash-backup.bin", new Blob(["backup"])),
    (error) => error instanceof DeviceArtifactError && /Persistent browser storage/.test(error.message),
  );
  assert.deepEqual(store.list("session-a"), []);
});

test("authorized file imports use only Cody's guarded per-session file route", () => {
  assert.equal(
    authorizedArtifactDownloadUrl("session-a", "/workspace/firmware image.bin"),
    "/api/files/workspace/firmware%20image.bin?type=download&sessionId=session-a",
  );
  assert.throws(() => authorizedArtifactDownloadUrl("", "/workspace/firmware.bin"), DeviceArtifactError);
  assert.throws(() => authorizedArtifactDownloadUrl("session-a", ""), DeviceArtifactError);
});
