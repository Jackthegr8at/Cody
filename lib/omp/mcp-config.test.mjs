import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// User-scope writes land in `getAgentDir()`. Point that at a temp dir BEFORE
// importing the module, or the tests edit the running instance's real
// /data/agent/mcp.json (see AGENTS.md, checkpoints).
const agentDir = mkdtempSync(join(tmpdir(), "cody-mcp-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OMP_PROFILE = "";
process.env.PI_PROFILE = "";
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url);
const {
  deleteMcpServer,
  getUserMcpPath,
  parseMcpListOutput,
  readMcpConfig,
  readUserMcpConfig,
  setUserServerDisabled,
  validateMcpServer,
  writeMcpServer,
} = await jiti.import("./mcp-config.ts");
const { MCP_SECRET_SENTINEL, maskMcpSecrets } = await jiti.import("../mcp-secrets.ts");

const userPath = getUserMcpPath();
const readUserFile = () => JSON.parse(readFileSync(userPath, "utf8"));

function withUserConfig(contents, run) {
  if (contents === null) rmSync(userPath, { force: true });
  else writeFileSync(userPath, `${JSON.stringify(contents, null, 2)}\n`);
  try {
    run();
  } finally {
    rmSync(userPath, { force: true });
  }
}

function withWorkspace(run) {
  const dir = mkdtempSync(join(tmpdir(), "cody-mcp-config-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const project = (cwd) => ({ scope: "project", cwd });

test("writes, renames, and removes a native project MCP server", () => {
  withWorkspace((cwd) => {
    writeMcpServer(project(cwd), "filesystem", { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] });
    let file = readMcpConfig(cwd);
    assert.match(file.path.replace(/\\/g, "/"), /\.omp\/mcp\.json$/);
    assert.equal(file.config.mcpServers.filesystem.command, "npx");

    writeMcpServer(project(cwd), "project-files", { type: "stdio", command: "npx", args: [] }, "filesystem");
    file = readMcpConfig(cwd);
    assert.deepEqual(Object.keys(file.config.mcpServers), ["project-files"]);

    deleteMcpServer(project(cwd), "project-files");
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers, {});

    // A project write needs a workspace; without one it must refuse rather
    // than fall back to the user-level file.
    assert.throws(() => writeMcpServer({ scope: "project" }, "orphan", { command: "npx" }), /requires a workspace/);
    assert.equal(existsSync(getUserMcpPath()), false);
  });
});

test("rejects malformed MCP transports before writing", () => {
  assert.throws(() => validateMcpServer("bad server", { command: "npx" }), /Server name/);
  assert.throws(() => validateMcpServer("bad", { type: "http", command: "npx" }), /requires a URL/);
  assert.throws(() => validateMcpServer("bad", { command: "npx", url: "https://example.com/mcp" }), /exactly one/);
  assert.throws(() => validateMcpServer("bad", { type: "sse", url: "file:///tmp/mcp" }), /http or https/);
});

test("reads OMP user MCP servers and disabled entries", () => {
  withWorkspace((cwd) => {
    const filePath = join(cwd, "user-mcp.json");
    writeFileSync(filePath, JSON.stringify({
      mcpServers: { ida: { command: "python", args: ["server.py"] } },
      disabledServers: ["node_repl"],
    }));

    const config = readUserMcpConfig(filePath);
    assert.deepEqual(config.servers.map(({ name }) => name), ["ida"]);
    assert.deepEqual(config.disabledServers, ["node_repl"]);
  });
});

test("parses every source and connection state from OMP's MCP list", () => {
  const servers = parseMcpListOutput(`\nConfigured MCP Servers\n\nUser level (~/.omp/agent/mcp.json):\n  ida ● connected [stdio]\n  frida ○ not connected [stdio]\n\nProject level (.omp/mcp.json):\n  docs ◌ connecting [http]\n\nClaude Code (~/.claude.json):\n  ida-reverse-engineering ● connected\n\nDisabled (discovered servers):\n  node_repl ◌ disabled\n`);
  assert.deepEqual(servers, [
    { name: "ida", source: "User level", status: "connected", type: "stdio" },
    { name: "frida", source: "User level", status: "not_connected", type: "stdio" },
    { name: "docs", source: "Project level", status: "connecting", type: "http" },
    { name: "ida-reverse-engineering", source: "Claude Code", status: "connected", type: undefined },
    { name: "node_repl", source: "Disabled", status: "disabled", type: undefined },
  ]);
});

test("parses rpc-ui's compact MCP list without claiming configured servers are connected", () => {
  assert.deepEqual(parseMcpListOutput("ida | stdio | enabled | python [user]\nfrida | stdio | disabled | frida serve [project]"), [
    { name: "ida", source: "User level", status: "configured", type: "stdio" },
    { name: "frida", source: "Project level", status: "disabled", type: "stdio" },
  ]);
});

test("serializes concurrent mutations through the config lock (no lost updates)", () => {
  withWorkspace((cwd) => {
    // Simulate two writers racing: each read-modify-write must re-read inside
    // the lock, so the second mutation preserves the first's server.
    writeMcpServer(project(cwd), "alpha", { type: "stdio", command: "python", args: ["a.py"] });
    writeMcpServer(project(cwd), "beta", { type: "stdio", command: "python", args: ["b.py"] });
    const file = readMcpConfig(cwd);
    assert.deepEqual(Object.keys(file.config.mcpServers).sort(), ["alpha", "beta"]);
    // Lock files must not leak after successful writes.
    assert.equal(existsSync(`${file.path}.lock`), false);
    assert.equal(existsSync(`${file.path}.tmp-${process.pid}-`), false);
  });
});

test("breaks a stale config lock from a crashed writer", () => {
  withWorkspace((cwd) => {
    const { path } = readMcpConfig(cwd);
    const lockPath = `${path}.lock`;
    // A lock file left behind by a crashed process, aged past the stale window.
    mkdirSync(join(dirname(lockPath)), { recursive: true });
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);

    writeMcpServer(project(cwd), "recovered", { type: "stdio", command: "python", args: ["r.py"] });
    const file = readMcpConfig(cwd);
    assert.equal(file.config.mcpServers.recovered.command, "python");
    assert.equal(existsSync(lockPath), false);
  });
});

test("writes, renames and removes a user-level MCP server in the agent dir", () => {
  withUserConfig(null, () => {
    const written = writeMcpServer({ scope: "user" }, "github", { type: "http", url: "https://api.githubcopilot.com/mcp/" });
    assert.equal(written.path, userPath);
    assert.equal(written.scope, "user");
    assert.equal(readUserFile().mcpServers.github.url, "https://api.githubcopilot.com/mcp/");
    // No workspace was involved: a user-level server is not project state.
    assert.deepEqual(readUserMcpConfig(userPath).servers.map(({ name }) => name), ["github"]);

    writeMcpServer({ scope: "user" }, "gh", { type: "http", url: "https://api.githubcopilot.com/mcp/" }, "github");
    assert.deepEqual(Object.keys(readUserFile().mcpServers), ["gh"]);

    deleteMcpServer({ scope: "user" }, "gh");
    assert.deepEqual(readUserFile().mcpServers, {});
    assert.equal(existsSync(`${userPath}.lock`), false);
  });
});

test("a masked secret is merged back from disk, never persisted as the sentinel", () => {
  withUserConfig({
    $schema: "https://example.com/mcp.schema.json",
    enabledServers: ["docs"],
    mcpServers: { docs: { type: "http", url: "https://docs.test/mcp", headers: { Authorization: "Bearer real-token", "X-Trace": "on" } } },
  }, () => {
    // What the browser was shown: the config with every secret replaced.
    const masked = maskMcpSecrets(readUserMcpConfig(userPath).servers[0].config);
    assert.equal(masked.headers.Authorization, MCP_SECRET_SENTINEL);
    assert.equal(masked.headers["X-Trace"], MCP_SECRET_SENTINEL);

    // Saving it back changes only the URL; both secrets survive verbatim.
    writeMcpServer({ scope: "user" }, "docs", { ...masked, url: "https://docs.test/mcp/v2" });
    const saved = readUserFile();
    assert.equal(saved.mcpServers.docs.url, "https://docs.test/mcp/v2");
    assert.equal(saved.mcpServers.docs.headers.Authorization, "Bearer real-token");
    assert.equal(saved.mcpServers.docs.headers["X-Trace"], "on");
    assert.ok(!JSON.stringify(saved).includes(MCP_SECRET_SENTINEL));
    // Unrelated top-level keys survive the read-modify-write.
    assert.equal(saved.$schema, "https://example.com/mcp.schema.json");
    assert.deepEqual(saved.enabledServers, ["docs"]);

    // A sentinel with nothing behind it is refused, not written: a new header
    // (or a new server) has no stored value to keep.
    assert.throws(
      () => writeMcpServer({ scope: "user" }, "docs", { type: "http", url: "https://docs.test/mcp", headers: { "X-New": MCP_SECRET_SENTINEL } }),
      /No saved value for headers\.X-New/,
    );
    assert.equal(readUserFile().mcpServers.docs.url, "https://docs.test/mcp/v2");

    // The project file is served raw, so nothing is ever merged into it.
    withWorkspace((cwd) => {
      writeMcpServer(project(cwd), "docs", { type: "http", url: "https://docs.test/mcp", headers: { Authorization: MCP_SECRET_SENTINEL } });
      assert.equal(readMcpConfig(cwd).config.mcpServers.docs.headers.Authorization, MCP_SECRET_SENTINEL);
    });
  });
});

test("the user denylist round-trips and the key disappears when it empties", () => {
  withUserConfig({
    $schema: "https://example.com/mcp.schema.json",
    mcpServers: { ida: { command: "python", args: ["server.py"] } },
  }, () => {
    assert.deepEqual(setUserServerDisabled("ida", true).disabledServers, ["ida"]);
    assert.deepEqual(readUserFile().disabledServers, ["ida"]);
    // Disabling twice is not a duplicate entry.
    assert.deepEqual(setUserServerDisabled("ida", true).disabledServers, ["ida"]);
    assert.deepEqual(readUserMcpConfig(userPath).disabledServers, ["ida"]);

    // A rename carries the denylist entry, so the server does not come back
    // enabled under its new name.
    writeMcpServer({ scope: "user" }, "ida-pro", { command: "python", args: ["server.py"] }, "ida");
    assert.deepEqual(readUserFile().disabledServers, ["ida-pro"]);

    assert.deepEqual(setUserServerDisabled("ida-pro", false).disabledServers, []);
    const enabled = readUserFile();
    assert.equal("disabledServers" in enabled, false, "an empty denylist is dropped, not left as []");
    assert.equal(enabled.$schema, "https://example.com/mcp.schema.json");

    // Deleting a disabled server takes its denylist entry with it.
    setUserServerDisabled("ida-pro", true);
    deleteMcpServer({ scope: "user" }, "ida-pro");
    assert.equal("disabledServers" in readUserFile(), false);
  });
});
