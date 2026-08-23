import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentLoop } from "../src/agent-loop.mjs";
import { compactMessages, estimateTokens, transcriptSize } from "../src/compaction.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";

class FakeClient {
  constructor(script, { numCtx, tokenCounts = [] } = {}) {
    this.script = [...script];
    this.calls = [];
    this.numCtx = numCtx;
    this.tokenCounts = [...tokenCounts];
  }

  async chat(request) {
    this.calls.push(structuredClone(request));
    const message = this.script.shift();
    if (!message) throw new Error("FakeClient script exhausted.");
    const raw = { message };
    const tokens = this.tokenCounts.shift();
    if (tokens !== undefined) {
      raw.prompt_eval_count = tokens;
      raw.eval_count = 0;
    }
    return { message, raw };
  }
}

function longTranscript() {
  const messages = [{ role: "system", content: "SYSTEM" }];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "user", content: `question ${i} ${"x".repeat(500)}` });
    messages.push({ role: "assistant", content: `answer ${i} ${"y".repeat(500)}` });
  }
  return messages;
}

test("transcript under the budget is returned untouched (same reference)", async () => {
  const client = new FakeClient([]);
  const messages = [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: "short" },
  ];

  const result = await compactMessages({ client, messages, maxChars: 1000 });
  assert.equal(result, messages);
  assert.equal(client.calls.length, 0);
});

test("over budget: old turns are replaced by a summary, recent turns kept", async () => {
  const client = new FakeClient([{ role: "assistant", content: "SUMMARY OF OLD TURNS" }]);
  const messages = longTranscript();

  const result = await compactMessages({ client, messages, maxChars: 2000, keepRecent: 4 });

  assert.notEqual(result, messages);
  assert.equal(result[0].content, "SYSTEM");
  assert.match(result[1].content, /compacted to save space/);
  assert.match(result[1].content, /SUMMARY OF OLD TURNS/);
  // summary + system + last 4 verbatim
  assert.equal(result.length, 6);
  assert.deepEqual(result.slice(2), messages.slice(-4));
  assert.ok(transcriptSize(result) < transcriptSize(messages));
});

test("kept window widens so it never starts on a tool result", async () => {
  const client = new FakeClient([{ role: "assistant", content: "SUMMARY" }]);
  const messages = [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: "x".repeat(3000) },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "t", arguments: {} } }] },
    { role: "tool", tool_name: "t", content: "result" },
    { role: "assistant", content: "done with tools" },
    { role: "user", content: "next" },
  ];

  // keepRecent 4 would start the window on the tool message; it must widen
  // to include the assistant message that requested the call.
  const result = await compactMessages({ client, messages, maxChars: 100, keepRecent: 4 });
  const firstKept = result[2];
  assert.equal(firstKept.role, "assistant");
  assert.ok(firstKept.tool_calls, "window starts at the tool-calling assistant message");
});

test("estimateTokens takes the max of observed usage and the chars/4 heuristic", () => {
  const messages = [{ role: "user", content: "x".repeat(4000) }]; // ~1000 tokens
  assert.equal(estimateTokens(messages), 1000);
  assert.equal(estimateTokens(messages, 5000), 5000);
});

test("token budget triggers compaction even when the char budget would not", async () => {
  const client = new FakeClient([{ role: "assistant", content: "SUMMARY" }]);
  const messages = longTranscript(); // ~10k chars, well under the default 24k char budget

  const result = await compactMessages({
    client,
    messages,
    maxTokens: 2000,
    observedTokens: 9000, // model reported real usage past the budget
    keepRecent: 4,
  });

  assert.notEqual(result, messages);
  assert.match(result[1].content, /SUMMARY/);
});

test("token budget set and under it: no compaction, even past the char default", async () => {
  const client = new FakeClient([]);
  const messages = [{ role: "system", content: "SYSTEM" }];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: "user", content: "x".repeat(1000) }); // ~30k chars -> ~7.5k tokens
  }

  const result = await compactMessages({ client, messages, maxTokens: 12_000 });

  assert.equal(result, messages);
  assert.equal(client.calls.length, 0);
});

test("summarizer failure leaves the transcript unchanged", async () => {
  const failing = {
    async chat() {
      throw new Error("model offline");
    },
  };
  const messages = longTranscript();
  const result = await compactMessages({ client: failing, messages, maxChars: 100 });
  assert.equal(result, messages);
});

test("agent loop compacts a long history before calling the model", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "HISTORY SUMMARY" }, // compaction call
    { role: "assistant", content: "final answer" }, // the actual run
  ]);
  const registry = new ToolRegistry();
  registry.register({ name: "noop", execute: () => "ok" });
  const loop = new AgentLoop({
    client,
    registry,
    compaction: { maxChars: 2000, keepRecent: 4 },
  });

  const result = await loop.run("continue", { history: longTranscript() });

  assert.equal(result.text, "final answer");
  // First call is the summarizer (no tools); second is the compacted run.
  assert.equal(client.calls[0].tools, undefined);
  const runMessages = client.calls[1].messages;
  assert.equal(runMessages[0].content, "SYSTEM");
  assert.match(runMessages[1].content, /HISTORY SUMMARY/);
  assert.ok(runMessages.length < 23, "transcript shrank");
});

test("loop derives a token budget from the client's numCtx and compacts on real usage", async () => {
  const toolCall = { function: { name: "noop", arguments: {} } };
  const client = new FakeClient(
    [
      { role: "assistant", content: "", tool_calls: [toolCall] }, // step 1
      { role: "assistant", content: "HISTORY SUMMARY" }, // summarizer (triggered before step 2)
      { role: "assistant", content: "final answer" }, // step 2
    ],
    {
      numCtx: 1000, // budget = 750 tokens
      tokenCounts: [900], // step 1 reports usage over the budget
    },
  );
  const registry = new ToolRegistry();
  registry.register({ name: "noop", execute: () => "ok" });
  const loop = new AgentLoop({ client, registry, compaction: { keepRecent: 2 } });

  const result = await loop.run("go");

  assert.equal(result.text, "final answer");
  // Transcript is only ~100 chars — the char heuristic alone would never
  // trigger; the summarizer call proves the reported tokens did.
  const summarizerCall = client.calls[1];
  assert.equal(summarizerCall.tools, undefined);
  const finalCall = client.calls[2];
  assert.match(finalCall.messages[1].content, /HISTORY SUMMARY/);
});

test("loop without compaction option never makes a summarizer call", async () => {
  const client = new FakeClient([{ role: "assistant", content: "answer" }]);
  const registry = new ToolRegistry();
  registry.register({ name: "noop", execute: () => "ok" });
  const loop = new AgentLoop({ client, registry });

  await loop.run("continue", { history: longTranscript() });
  assert.equal(client.calls.length, 1);
});
