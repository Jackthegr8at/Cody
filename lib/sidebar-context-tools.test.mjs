import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

// Import live modules under test
const { SIDEBAR_CONTEXT_TOOLS } = await jiti.import("./sidebar-context-tools.ts");
// The session three and their shared texts live in the module both the
// sidebar and every main chat use.
const { SESSION_NOT_FOUND } = await jiti.import("./session-tools.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const { resultCharBudget } = await jiti.import("./sidebar-context-budget.ts");
const { setSessionOwner } = await jiti.import("./auth/session-owners.ts");

// ============================================================================
// Test fixtures & helpers
// ============================================================================

async function withWorkspace(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-sidebar-ws-"));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withAgentDir(run) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-sidebar-agent-"));
  const sessionsDir = path.join(agentDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  try {
    return await run(agentDir, sessionsDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

function writeSessionFile(dir, name, header, entries = []) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  const lines = [JSON.stringify({ type: "session", version: 3, ...header })];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

function userEntry(id, parentId, content, timestamp = "2026-01-01T00:00:00.000Z") {
  return { type: "message", id, parentId, timestamp, message: { role: "user", content } };
}

function assistantEntry(id, parentId, blocks, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "assistant", provider: "test", modelId: "test-model", content: blocks },
  };
}

function fakeUser(id) {
  return { id, username: id, fullName: id, role: "member", tokenVersion: 0, createdAt: "2026-01-01T00:00:00.000Z" };
}

function findTool(name) {
  const tool = SIDEBAR_CONTEXT_TOOLS.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} not found in registry`);
  return tool;
}

// ============================================================================
// Tests: read_workspace_file path safety
// ============================================================================

test("read_workspace_file rejects traversal via ..", async () => {
  await withWorkspace(async (cwd) => {
    const ctx = { cwd, user: null, defaultSessionId: null };
    const tool = findTool("read_workspace_file");
    const result = await tool.handler({ path: "../outside.txt" }, ctx);
    assert.match(result, /outside the workspace/i);
  });
});

test("read_workspace_file rejects absolute paths outside root", async () => {
  await withWorkspace(async (cwd) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cody-sidebar-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
      const ctx = { cwd, user: null, defaultSessionId: null };
      const tool = findTool("read_workspace_file");
      const result = await tool.handler({ path: path.join(outside, "secret.txt") }, ctx);
      assert.match(result, /outside the workspace|not found/i);
      assert.ok(!result.includes("SECRET"), "must not leak content from outside workspace");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("read_workspace_file rejects symlink escape", async (t) => {
  await withWorkspace(async (cwd) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cody-sidebar-target-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "SYMLINK_SECRET");
      const linkPath = path.join(cwd, "link.txt");
      try {
        fs.symlinkSync(path.join(outside, "secret.txt"), linkPath, "file");
      } catch (error) {
        if (process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES")) {
          t.skip("Creating file symlinks requires Windows Developer Mode or privilege");
          return;
        }
        throw error;
      }

      const ctx = { cwd, user: null, defaultSessionId: null };
      const tool = findTool("read_workspace_file");
      const result = await tool.handler({ path: "link.txt" }, ctx);
      assert.match(result, /outside the workspace|not found/i);
      assert.ok(!result.includes("SYMLINK_SECRET"), "must not leak content from symlink escape");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("read_workspace_file reads a normal file", async () => {
  await withWorkspace(async (cwd) => {
    const content = "Hello, workspace!";
    fs.writeFileSync(path.join(cwd, "test.txt"), content);
    const ctx = { cwd, user: null, defaultSessionId: null };
    const tool = findTool("read_workspace_file");
    const result = await tool.handler({ path: "test.txt" }, ctx);
    assert.equal(result, content);
  });
});

test("read_workspace_file detects binary and rejects", async () => {
  await withWorkspace(async (cwd) => {
    fs.writeFileSync(path.join(cwd, "binary.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x00]));
    const ctx = { cwd, user: null, defaultSessionId: null };
    const tool = findTool("read_workspace_file");
    const result = await tool.handler({ path: "binary.bin" }, ctx);
    assert.match(result, /binary/i);
  });
});

// ============================================================================
// Tests: read_workspace_file paging
// ============================================================================

test("read_workspace_file pages an oversized file and nextOffset advances", async () => {
  await withWorkspace(async (cwd) => {
    const budgetChars = resultCharBudget(undefined);
    const body = Array.from(
      { length: Math.ceil(budgetChars / 8) },
      (_, i) => `line ${i} content for paging fixture`
    ).join("\n");
    fs.writeFileSync(path.join(cwd, "big.txt"), body);

    const ctx = { cwd, user: null, defaultSessionId: null };
    const tool = findTool("read_workspace_file");
    let offset = 0;
    let reconstructed = "";
    let pages = 0;
    for (;;) {
      const result = await tool.handler({ path: "big.txt", offset }, ctx);
      const hintMatch = /\[truncated, \d+ chars remain — call again with offset=(\d+)\]$/.exec(result);
      const text = hintMatch ? result.slice(0, hintMatch.index).replace(/\n$/, "") : result;
      reconstructed += text;
      pages++;
      if (!hintMatch) break;
      const nextOffset = Number(hintMatch[1]);
      assert.ok(nextOffset > offset, `offset must advance: ${nextOffset} > ${offset}`);
      offset = nextOffset;
      assert.ok(pages < 100, "paging did not terminate in reasonable iterations");
    }
    assert.ok(pages > 1, "fixture should require more than one page");
    assert.equal(reconstructed, body, "reconstructed content must match original file");
  });
});

// ============================================================================
// Tests: list_workspace_files
// ============================================================================

test("list_workspace_files caps at MAX entries and notes overflow", async () => {
  await withWorkspace(async (cwd) => {
    for (let i = 0; i < 205; i++) {
      fs.writeFileSync(path.join(cwd, `file-${String(i).padStart(3, "0")}.txt`), "x");
    }
    const ctx = { cwd, user: null, defaultSessionId: null };
    const tool = findTool("list_workspace_files");
    const result = await tool.handler({}, ctx);
    const lines = result.split("\n");
    assert.ok(lines.length <= 202, `should show ≤200 files + 1 overflow note, got ${lines.length}`);
    assert.match(result, /… 5 more not shown/, "must note overflow");
  });
});

test("list_workspace_files filters by glob pattern", async () => {
  await withWorkspace(async (cwd) => {
    fs.writeFileSync(path.join(cwd, "foo.ts"), "");
    fs.writeFileSync(path.join(cwd, "bar.js"), "");
    fs.writeFileSync(path.join(cwd, "baz.ts"), "");
    const ctx = { cwd, user: null, defaultSessionId: null };
    const tool = findTool("list_workspace_files");
    const result = await tool.handler({ pattern: "*.ts" }, ctx);
    assert.match(result, /foo\.ts/);
    assert.match(result, /baz\.ts/);
    assert.ok(!result.includes("bar.js"), "must exclude .js files");
  });
});

// ============================================================================
// Tests: read_project_context
// ============================================================================

test("read_project_context reads AGENTS.md when present", async () => {
  await withWorkspace(async (cwd) => {
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# Agents\nProject agents documented here.");
    const ctx = { cwd, user: null, defaultSessionId: null };
    const tool = findTool("read_project_context");
    const result = await tool.handler({}, ctx);
    assert.match(result, /AGENTS\.md/);
    assert.match(result, /Project agents/);
  });
});

test("read_project_context returns none-found message when absent", async () => {
  await withWorkspace(async (cwd) => {
    const ctx = { cwd, user: null, defaultSessionId: null };
    const tool = findTool("read_project_context");
    const result = await tool.handler({}, ctx);
    assert.match(result, /No AGENTS\.md, CLAUDE\.md, or \.omp\/rules found/i);
  });
});

// ============================================================================
// Tests: list_sessions
// ============================================================================

test("list_sessions lists accessible sessions with running state", async () => {
  await withAgentDir(async (agentDir, sessionsDir) => {
    const projectDir = path.join(sessionsDir, "-project");
    writeSessionFile(projectDir, "s1.jsonl", { id: "s1", cwd: "/proj1", title: "First", created: new Date("2026-01-02"), modified: new Date("2026-01-02") }, [
      userEntry("m1", null, "hello"),
    ]);
    const ctx = { cwd: "/proj1", user: null, defaultSessionId: null, runningSessionIds: new Set(["s1"]) };
    const tool = findTool("list_sessions");
    const result = await tool.handler({}, ctx);
    assert.match(result, /s1/);
    assert.match(result, /First/);
    assert.match(result, /running/);
  });
});

test("list_sessions filters by workspace path", async () => {
  await withAgentDir(async (agentDir, sessionsDir) => {
    const projectDir = path.join(sessionsDir, "-project");
    writeSessionFile(projectDir, "s1.jsonl", {
      id: "s1",
      cwd: "/proj1",
      title: "Proj1Session",
      created: new Date("2026-01-01"),
      modified: new Date("2026-01-01"),
    }, [userEntry("m1", null, "hello")]);
    writeSessionFile(projectDir, "s2.jsonl", {
      id: "s2",
      cwd: "/proj2",
      title: "Proj2Session",
      created: new Date("2026-01-02"),
      modified: new Date("2026-01-02"),
    }, [userEntry("m2", null, "world")]);

    const ctx = { cwd: "/proj1", user: null, defaultSessionId: null };
    const tool = findTool("list_sessions");
    const result = await tool.handler({ workspace: "/proj1" }, ctx);
    assert.match(result, /s1/);
    assert.ok(!result.includes("s2"), "must filter to workspace path");
  });
});

// ============================================================================
// Tests: read_session ownership & access
// ============================================================================

test("read_session: blocked session answers not-found same as missing", async () => {
  await withAgentDir(async (agentDir, sessionsDir) => {
    const projectDir = path.join(sessionsDir, "-project");
    writeSessionFile(projectDir, "s1.jsonl", {
      id: "s1",
      cwd: "/proj",
      title: "Blocked",
      created: new Date("2026-01-01"),
      modified: new Date("2026-01-01"),
    }, [userEntry("m1", null, "test")]);

    setSessionOwner("s1", "other-user");

    const ctx = {
      cwd: "/proj",
      user: fakeUser("me"),
      defaultSessionId: null,
    };
    const tool = findTool("read_session");
    const blockedResult = await tool.handler({ session: "s1" }, ctx);
    assert.equal(blockedResult, SESSION_NOT_FOUND, "blocked session must answer not-found");
    const missingResult = await tool.handler({ session: "nonexistent" }, ctx);
    assert.equal(missingResult, SESSION_NOT_FOUND, "missing session must answer not-found");
    assert.equal(blockedResult, missingResult, "blocked and missing must be indistinguishable");
  });
});

test("read_session: title ambiguity returns candidates, no guessing", async () => {
  await withAgentDir(async (agentDir, sessionsDir) => {
    const projectDir = path.join(sessionsDir, "-project");
    writeSessionFile(projectDir, "s1.jsonl", {
      id: "s1",
      cwd: "/proj",
      title: "Fix login bug",
      created: new Date("2026-01-01"),
      modified: new Date("2026-01-01"),
    }, [userEntry("m1", null, "testing s1")]);

    writeSessionFile(projectDir, "s2.jsonl", {
      id: "s2",
      cwd: "/proj",
      title: "Fix login flow",
      created: new Date("2026-01-02"),
      modified: new Date("2026-01-02"),
    }, [userEntry("m2", null, "testing s2")]);

    const ctx = { cwd: "/proj", user: null, defaultSessionId: null };
    const tool = findTool("read_session");
    const result = await tool.handler({ session: "Fix login" }, ctx);
    assert.match(result, /Multiple sessions match/i);
    assert.match(result, /s1/);
    assert.match(result, /s2/);
    assert.ok(!result.includes("testing"), "must not return condensed content when ambiguous");
  });
});

test("read_session: unique title resolves and returns condensed content", async () => {
  await withAgentDir(async (agentDir, sessionsDir) => {
    const projectDir = path.join(sessionsDir, "-project");
    const mid = "m1";
    writeSessionFile(projectDir, "s1.jsonl", {
      id: "s1",
      cwd: "/proj",
      title: "Unique Session Name",
      created: new Date("2026-01-01"),
      modified: new Date("2026-01-01"),
    }, [userEntry(mid, null, "User message here")]);

    const ctx = { cwd: "/proj", user: null, defaultSessionId: null };
    const tool = findTool("read_session");
    const result = await tool.handler({ session: "Unique Session" }, ctx);
    assert.match(result, /User: User message here/i);
    assert.ok(!result.includes("Multiple sessions"), "unique title must resolve directly");
  });
});

test("read_session: strips tool args and results, keeps tool name only", async () => {
  await withAgentDir(async (agentDir, sessionsDir) => {
    const projectDir = path.join(sessionsDir, "-project");
    const uid = "u1";
    const aid = "a1";
    writeSessionFile(projectDir, "s1.jsonl", {
      id: "s1",
      cwd: "/proj",
      title: "ToolSession",
      created: new Date("2026-01-01"),
      modified: new Date("2026-01-01"),
    }, [
      userEntry(uid, null, "run bash"),
      assistantEntry(aid, uid, [
        { type: "text", text: "Running command" },
        { type: "toolCall", toolCallId: "tc1", toolName: "bash", input: { command: "echo SENSITIVE_MARKER_XYZ" } },
      ]),
    ]);

    const ctx = { cwd: "/proj", user: null, defaultSessionId: null };
    const tool = findTool("read_session");
    const result = await tool.handler({ session: "s1" }, ctx);
    assert.match(result, /\[tool: bash\]/);
    assert.ok(!result.includes("SENSITIVE_MARKER_XYZ"), "must not leak tool input arguments");
  });
});

test("read_session: tail limits to recent messages and reverses newest-first", async () => {
  await withAgentDir(async (agentDir, sessionsDir) => {
    const projectDir = path.join(sessionsDir, "-project");
    const m1 = "m1", m2 = "m2", m3 = "m3", m4 = "m4";
    const a1 = "a1", a2 = "a2";
    writeSessionFile(projectDir, "s1.jsonl", {
      id: "s1",
      cwd: "/proj",
      title: "TailSession",
      created: new Date("2026-01-01"),
      modified: new Date("2026-01-01"),
    }, [
      userEntry(m1, null, "first"),
      assistantEntry(a1, m1, [{ type: "text", text: "reply1" }]),
      userEntry(m2, a1, "second"),
      assistantEntry(a2, m2, [{ type: "text", text: "reply2" }]),
      userEntry(m3, a2, "third"),
      userEntry(m4, m3, "fourth"),
    ]);

    const ctx = { cwd: "/proj", user: null, defaultSessionId: null };
    const tool = findTool("read_session");
    const result = await tool.handler({ session: "s1", tail: 2 }, ctx);
    const lines = result.split("\n\n");
    assert.ok(lines.length <= 3, `tail:2 should show ≤2 messages, got ${lines.length}`);
    assert.ok(
      result.includes("fourth") || result.includes("third"),
      "must show one of the two newest messages"
    );
  });
});

// ============================================================================
// Tests: schema token budget
// ============================================================================

test("the sidebar's tool schemas stay well under its 900-token budget", () => {
  const schemas = SIDEBAR_CONTEXT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const chars = JSON.stringify(schemas).length;
  const tokens = chars / 4;
  console.log(`Schema token size: ${Math.round(tokens)} tokens (${chars} chars)`);
  assert.ok(tokens < 900, `schemas must stay under 900 tokens; got ${Math.round(tokens)}`);
});
