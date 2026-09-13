import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../..", import.meta.url).pathname.replace(/\/$/, "") } });
const { DirectChatError, directTargets, parseDirectRequest, streamDirectChat } = await jiti.import("./service.ts");
const { matchesEnabledModel } = await jiti.import("../harness/direct-model-config.ts");
const { POST: compactPost } = await jiti.import("../../app/api/direct-chat/compact/route.ts");

const encoder = new TextEncoder();

function sseResponse(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

async function streamText(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) return text + decoder.decode();
    text += decoder.decode(result.value, { stream: true });
  }
}

function target(dialect = "openai") {
  return {
    model: { key: "local/model", id: "model", name: "model", provider: "local", contextWindow: 8192, maxOutputTokens: 512, available: true, capabilities: { reasoning: { available: false }, fast: { available: false }, images: { available: false }, attachments: { available: false }, skills: { available: true } } },
    dialect, baseUrl: "http://127.0.0.1:9292/v1",
  };
}

const input = { modelKey: "local/model", messages: [{ role: "user", content: "hello" }] };

test("streams split OpenAI SSE events and flushes the terminal unframed event", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return sseResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"hel", "lo\"}}]}\n\n", "data: [DONE]"]);
  };
  try {
    const output = await streamText(streamDirectChat(target(), input, new AbortController().signal));
    assert.match(output, /event: delta\ndata: {"text":"hello"}/);
    assert.match(output, /event: done\ndata: {}/);
    assert.equal((output.match(/event: done/g) ?? []).length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:9292/v1/chat/completions");
    assert.equal(JSON.parse(calls[0].init.body).stream, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("uses Anthropic messages and turns upstream SSE errors into one sanitized terminal event", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(["event: error\ndata: {\"type\":\"error\",\"error\":{\"message\":\"key sk-secret\"}}\n\n"]);
  try {
    const output = await streamText(streamDirectChat(target("anthropic"), input, new AbortController().signal));
    assert.match(output, /event: error\ndata: {"message":"The direct model reported an error\."}/);
    assert.doesNotMatch(output, /sk-secret/);
    assert.doesNotMatch(output, /event: done/);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects unsupported attachments and bounded request overflows before upstream work", () => {
  assert.equal(parseDirectRequest({ modelKey: "x", messages: [{ role: "user", content: "x", attachments: [{ id: "i", name: "fixture.txt", mimeType: "text/plain", dataUrl: "data:text/plain;base64,eA==" }] }] }).messages[0].attachments[0].textContent, "x");
  assert.throws(() => parseDirectRequest({ modelKey: "x", messages: [{ role: "user", content: "x", attachments: [{ id: "i", name: "binary.bin", mimeType: "application/octet-stream", dataUrl: "data:application/octet-stream;base64,AAE=" }] }] }), DirectChatError);
  assert.throws(() => parseDirectRequest({ modelKey: "x", messages: Array.from({ length: 81 }, () => ({ role: "user", content: "x" })) }), DirectChatError);
});
test("rejects a truncated stream instead of marking it done", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"]);
  try {
    const output = await streamText(streamDirectChat(target(), input, new AbortController().signal));
    assert.match(output, /event: delta/);
    assert.match(output, /event: error\ndata: {"message":"The direct model stream ended before completion\."}/);
    assert.doesNotMatch(output, /event: done/);
  } finally { globalThis.fetch = originalFetch; }
});


test("matches native enabledModels semantics for nested provider ids and bare ids", () => {
  assert.equal(matchesEnabledModel("openrouter/**", "openrouter", "vendor/model"), true);
  assert.equal(matchesEnabledModel("openrouter/*", "openrouter", "vendor/model"), false);
  assert.equal(matchesEnabledModel("gpt-*", "openai", "gpt-5"), true);
  assert.equal(matchesEnabledModel("OpenAI/**", "openai", "gpt-5"), false, "case remains significant like Bun.Glob on Linux");
  assert.equal(matchesEnabledModel("{openai,anthropic}/**", "anthropic", "claude/sonnet"), true);
  assert.equal(matchesEnabledModel("openai/gpt-[45]", "openai", "gpt-5"), true);
  assert.equal(matchesEnabledModel("openai/gpt-[!4]", "openai", "gpt-5"), true);
  assert.equal(matchesEnabledModel("anthropic/**", "openai", "gpt-5"), false);
});

test("uses OpenAI reasoning dialect and validates configured controls", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return sseResponse(["data: {\"choices\":[{\"delta\":{}}]}\n\ndata: [DONE]\n\n"]);
  };
  const reasoningTarget = {
    ...target(),
    outputTokenField: "max_completion_tokens",
    reasoning: { kind: "openai", efforts: ["low", "high"] },
    fast: { kind: "openai-priority" },
    model: { ...target().model, capabilities: { ...target().model.capabilities, reasoning: { available: true, efforts: ["low", "high"] }, fast: { available: true } } },
  };
  try {
    const output = await streamText(streamDirectChat(reasoningTarget, { ...input, reasoningEffort: "high", fast: true }, new AbortController().signal));
    assert.match(output, /event: done/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].max_completion_tokens, 512);
    assert.equal(calls[0].max_tokens, undefined);
    assert.equal(calls[0].reasoning_effort, "high");
    assert.equal(calls[0].service_tier, "priority");

    const rejected = await streamText(streamDirectChat(reasoningTarget, { ...input, reasoningEffort: "xhigh" }, new AbortController().signal));
    assert.match(rejected, /That reasoning effort is unavailable/);
    assert.equal(calls.length, 1, "invalid effort never reaches the provider");
  } finally { globalThis.fetch = originalFetch; }
});


test("direct roster applies native curation without hiding OAuth-only configured models", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(path.join(tmpdir(), "cody-direct-models-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFileSync(path.join(agentDir, "models.yml"), `providers:
  local:
    baseUrl: http://127.0.0.1:9292/v1
    api: openai-completions
    auth: none
    models:
      - id: vendor/model
        name: Nested local
  subscription:
    baseUrl: https://example.invalid/v1
    api: openai-completions
    auth: oauth
    models:
      - id: only-oauth
`);
    writeFileSync(path.join(agentDir, "config.yml"), "enabledModels:\n  - local/**\n  - subscription/**\n");
    let roster = directTargets();
    assert.deepEqual(roster.map((entry) => entry.model.key).sort(), ["local/vendor/model", "subscription/only-oauth"]);
    const oauth = roster.find((entry) => entry.model.key === "subscription/only-oauth").model;
    assert.equal(oauth.available, false);
    assert.match(oauth.reason, /OAuth-only/);

    writeFileSync(path.join(agentDir, "config.yml"), "enabledModels:\n  - local/**\n  - subscription/**\ndisabledProviders:\n  - local\n");
    roster = directTargets();
    assert.deepEqual(roster.map((entry) => entry.model.key), ["subscription/only-oauth"]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});


function directFixture() {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const authEnvironment = ["CODY_PASSWORD", "OMP_WEB_PASSWORD", "CODY_REQUIRE_ACCOUNTS", "OMP_WEB_REQUIRE_ACCOUNTS"].map((key) => [key, process.env[key]]);
  const agentDir = mkdtempSync(path.join(tmpdir(), "cody-direct-compact-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.CODY_PASSWORD = "";
  process.env.OMP_WEB_PASSWORD = "";
  process.env.CODY_REQUIRE_ACCOUNTS = "0";
  process.env.OMP_WEB_REQUIRE_ACCOUNTS = "0";
  writeFileSync(path.join(agentDir, "models.yml"), `providers:
  openai:
    baseUrl: http://127.0.0.1:9292/v1
    api: openai-completions
    auth: none
    models:
      - id: summary-model
        reasoning: true
        thinking:
          efforts: [low]
        maxTokens: 2048
`);
  return () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const [key, value] of authEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(agentDir, { recursive: true, force: true });
  };
}

function compactRequest(signal, messages) {
  return new Request("http://localhost/api/direct-chat/compact", { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelKey: "openai/summary-model", messages, reasoningEffort: "low", fast: true }) });
}

function longMessages() {
  return Array.from({ length: 7 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn-${index} ${"x".repeat(2_000)}` }));
}

test("direct compact sends durable sentinels and commits only after a terminal summary", async () => {
  const restore = directFixture();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return sseResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"GOALS: ship\\nCONSTRAINTS: local\\nUNFINISHED WORK: verify\"}}]}\n\ndata: [DONE]\n\n"]);
  };
  try {
    const response = await compactPost(compactRequest(undefined, longMessages()));
    const text = await response.text();
    assert.match(requests[0].messages[0].content, /GOALS.*CONSTRAINTS.*UNFINISHED WORK/s);
    assert.equal(requests[0].reasoning_effort, "low");
    assert.equal(requests[0].service_tier, "priority");
    assert.equal(requests[0].max_completion_tokens, 2048);
    assert.match(text, /event: progress/);
    assert.match(text, /event: complete/);
    const terminal = [...text.matchAll(/event: complete\ndata: (.+)/g)].map((match) => JSON.parse(match[1]))[0];
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.messages.length, 7, "summary replaces earlier history while retaining the recent window");
  } finally { globalThis.fetch = originalFetch; restore(); }
});

test("direct compact does not emit a replacement for upstream error, abort, or noop", async () => {
  const restore = directFixture();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => sseResponse(["event: error\ndata: {\"error\":{}}\n\n"]);
    let response = await compactPost(compactRequest(undefined, longMessages()));
    let text = await response.text();
    assert.match(text, /event: error/);
    assert.doesNotMatch(text, /event: complete/);

    const aborter = new AbortController();
    globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
      start(controller) { init.signal.addEventListener("abort", () => controller.close(), { once: true }); },
    }), { headers: { "Content-Type": "text/event-stream" } });
    response = await compactPost(compactRequest(aborter.signal, longMessages()));
    aborter.abort();
    text = await response.text();
    assert.match(text, /event: cancelled/);
    assert.doesNotMatch(text, /event: complete/);

    response = await compactPost(compactRequest(undefined, longMessages().slice(0, 2)));
    text = await response.text();
    assert.match(text, /event: noop/);
    assert.doesNotMatch(text, /event: complete/);
  } finally { globalThis.fetch = originalFetch; restore(); }
});

test("serializes validated text attachments as quoted OpenAI and Anthropic prompt blocks", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return sseResponse(["data: {\"choices\":[{\"delta\":{}}]}\n\ndata: [DONE]\n\n"]);
  };
  const textInput = parseDirectRequest({ modelKey: "local/model", messages: [{ role: "user", content: "Review this", attachments: [{ id: "i", name: "fixture.txt", mimeType: "text/plain", dataUrl: "data:text/plain;base64,aGVsbG8=" }] }] });
  try {
    await streamText(streamDirectChat(target(), textInput, new AbortController().signal));
    assert.ok(calls[0].messages[0].content.includes("Attached file: fixture.txt (text/plain)"));
    assert.ok(calls[0].messages[0].content.includes("hello"));
    assert.doesNotMatch(calls[0].messages[0].content, /aGVsbG8=/);
    await streamText(streamDirectChat(target("anthropic"), textInput, new AbortController().signal));
    assert.ok(calls[1].messages[0].content.includes("Attached file: fixture.txt (text/plain)"));
    assert.ok(calls[1].messages[0].content.includes("hello"));
    assert.doesNotMatch(calls[1].messages[0].content, /aGVsbG8=/);
  } finally { globalThis.fetch = originalFetch; }
});
