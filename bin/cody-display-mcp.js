#!/usr/bin/env node
"use strict";

const TODO_COLORS = new Set(["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"]);
const MAX_AGENT_LINE_BYTES = 300;

function oneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "…";
  const available = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const length = Buffer.byteLength(character, "utf8");
    if (bytes + length > available) break;
    output += character;
    bytes += length;
  }
  return output + suffix;
}

function formatTodoForAgent(doc) {
  const items = Array.isArray(doc?.items) ? doc.items.filter((item) => item && typeof item === "object").slice(0, 1000) : [];
  items.sort((left, right) => {
    const leftDone = left.status === "done";
    const rightDone = right.status === "done";
    if (leftDone !== rightDone) return Number(leftDone) - Number(rightDone);
    const leftOrder = Number.isFinite(left.order) ? left.order : 0;
    const rightOrder = Number.isFinite(right.order) ? right.order : 0;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });
  const lines = items.map((item) => {
    const state = item.status === "done" ? "[x]" : "[ ]";
    const color = TODO_COLORS.has(item.color) ? item.color : "none";
    const prefix = state + " " + String(item.id ?? "") + " " + truncateUtf8(oneLine(item.title), 105) + " (" + color + ") — ";
    const notes = truncateUtf8(oneLine(item.notes), Math.max(0, MAX_AGENT_LINE_BYTES - Buffer.byteLength(prefix, "utf8")));
    return prefix + notes;
  });
  if (lines.length === 0) lines.push("No to-do items.");
  const historyCount = Array.isArray(doc?.history) ? doc.history.length : 0;
  lines.push("History: " + historyCount + " " + (historyCount === 1 ? "entry" : "entries") + "; Cody keeps the newest 500.");
  return lines.join("\n");
}

async function main() {
  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("zod"),
  ]);
  const endpoint = process.env.CODY_DISPLAY_ENDPOINT;
  const todoEndpoint = process.env.CODY_TODO_ENDPOINT;
  const capability = process.env.CODY_DISPLAY_CAPABILITY;
  const sessionId = process.env.CODY_DISPLAY_SESSION_ID;
  const engineLabel = process.env.CODY_ENGINE_LABEL || "Agent";
  if (!endpoint || !capability) throw new Error("Cody display capability is unavailable");

  const server = new McpServer({ name: "cody-display", version: "1.0.0" });
  server.registerTool("open_preview", {
    title: "Open Cody Preview",
    description: "Open or refresh a running local web UI in Cody's Preview panel. Call this after starting or restarting a dev server and whenever the URL changes. The URL must use localhost or 127.0.0.1.",
    inputSchema: {
      url: z.string().describe("Container-local http(s) URL, for example http://127.0.0.1:3000"),
      title: z.string().max(160).optional().describe("Short label for the preview"),
      mode: z.enum(["auto", "stream", "native"]).optional().describe("Prefer auto unless a specific transport is required"),
    },
  }, async (input) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + capability, "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "HTTP " + response.status);
      const accepted = { accepted: true, requestId: body.requestId };
      return { content: [{ type: "text", text: JSON.stringify(accepted) }], structuredContent: accepted };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to open preview" }] };
    }
  });
  server.registerTool("cody_todo", {
    title: "Manage Cody To-do",
    description: "The user's own project to-do list (.cody/todo.json). Separate from your task plan: it holds what the user asked to remember. Use list before working through it, complete an item only when its work is actually done, reopen if you completed it by mistake, note to leave a short note on an item. The user sees every change with your name in the list's history.",
    inputSchema: {
      action: z.enum(["list", "add", "complete", "reopen", "note"]).describe("To-do action to perform"),
      id: z.string().max(10).optional().describe("To-do item id for complete, reopen, or note"),
      title: z.string().max(200).optional().describe("Title for a new to-do item"),
      notes: z.string().max(4000).optional().describe("Optional notes for a new item or required note text"),
      color: z.enum(["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"]).optional().describe("Optional color for a new item"),
    },
  }, async (input) => {
    try {
      if (!todoEndpoint || !sessionId) throw new Error("Cody to-do capability is unavailable");
      if (input.action === "add" && !input.title) throw new Error("add requires title");
      if ((input.action === "complete" || input.action === "reopen" || input.action === "note") && !input.id) {
        throw new Error(input.action + " requires id");
      }
      if (input.action === "note" && input.notes === undefined) throw new Error("note requires notes");

      const payload = { sessionId, op: input.action === "note" ? "update" : input.action };
      if (input.action === "add") {
        payload.title = input.title;
        if (input.notes !== undefined) payload.notes = input.notes;
        if (input.color !== undefined) payload.color = input.color;
      } else if (input.action === "complete" || input.action === "reopen") {
        payload.id = input.id;
      } else if (input.action === "note") {
        payload.id = input.id;
        payload.notes = input.notes;
      }

      const response = await fetch(todoEndpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + capability,
          "Content-Type": "application/json",
          "X-Cody-Engine-Label": engineLabel,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "HTTP " + response.status);
      return { content: [{ type: "text", text: formatTodoForAgent(body.doc) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to update the project to-do list" }] };
    }
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
