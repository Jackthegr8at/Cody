import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createJiti } from "jiti";

// Set temp dir for PI_CODING_AGENT_DIR before any imports that read env.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-mkdir-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => {
  try {
    fs.rmSync(agentDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { POST } = await jiti.import("./route.ts");

test("POST /api/cwd/mkdir - invalid name", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-mkdir-test-"));

  try {
    // Empty name
    let response = await POST(new Request("http://localhost/api/cwd/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: tempDir, name: "" }),
    }));
    assert.equal(response.status, 400);
    const data = await response.json();
    assert.equal(data.code, "name_required");

    // "." reserved
    response = await POST(new Request("http://localhost/api/cwd/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: tempDir, name: "." }),
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_name");

    // ".." reserved
    response = await POST(new Request("http://localhost/api/cwd/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: tempDir, name: ".." }),
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_name");

    // Contains /
    response = await POST(new Request("http://localhost/api/cwd/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: tempDir, name: "foo/bar" }),
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_name");

    // Contains \
    response = await POST(new Request("http://localhost/api/cwd/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: tempDir, name: "foo\\bar" }),
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_name");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST /api/cwd/mkdir - missing parent", async () => {
  const nonexistent = path.join(os.tmpdir(), `cody-mkdir-nonexistent-${Date.now()}`);
  assert(!fs.existsSync(nonexistent), "test setup: nonexistent path should not exist");

  const response = await POST(new Request("http://localhost/api/cwd/mkdir", {
    method: "POST",
    body: JSON.stringify({ path: nonexistent, name: "test" }),
  }));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "not_found");
});

test("POST /api/cwd/mkdir - success creates directory", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-mkdir-test-"));

  try {
    const response = await POST(new Request("http://localhost/api/cwd/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: tempDir, name: "myproject" }),
    }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(data.path, "response contains path");
    assert.ok(data.path.endsWith("myproject"), `path ends with folder name: ${data.path}`);

    // Verify directory exists on disk
    assert(fs.existsSync(data.path), "created directory exists on disk");
    assert(fs.statSync(data.path).isDirectory(), "created path is a directory");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST /api/cwd/mkdir - duplicate name", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-mkdir-test-"));

  try {
    // Create first folder
    const response1 = await POST(new Request("http://localhost/api/cwd/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: tempDir, name: "unique" }),
    }));
    assert.equal(response1.status, 200);

    // Try to create same name again
    const response2 = await POST(new Request("http://localhost/api/cwd/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: tempDir, name: "unique" }),
    }));
    assert.equal(response2.status, 409);
    assert.equal((await response2.json()).code, "already_exists");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
