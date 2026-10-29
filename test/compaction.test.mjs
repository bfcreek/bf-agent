import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentLoop } from "../src/agent-loop.mjs";
import {
  compactMessages,
  estimateTokens,
  extractOriginalInstruction,
  transcriptSize,
  SUMMARY_MAX_TOKENS,
} from "../src/compaction.mjs";
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
  assert.match(result[1].content, /Original user instruction \(verbatim/);
  assert.match(result[1].content, /question 0/);
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

test("summarizer failure retries then stubs a compact so the window still shrinks", async () => {
  const failing = {
    async chat() {
      throw new Error("model offline");
    },
  };
  const failures = [];
  const messages = longTranscript();
  const result = await compactMessages({
    client: failing,
    messages,
    maxChars: 100,
    keepRecent: 4,
    onFailure: (info) => failures.push(info),
  });
  assert.notEqual(result, messages);
  assert.equal(result.length, 6); // system + stub + keepRecent 4
  assert.match(result[1].content, /summarizer returned nothing usable/);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "summarizer-error");
  assert.equal(failures[0].recovered, true);
  assert.match(failures[0].error.message, /offline/);
});

test("an empty summary retries once, then stubs a compact instead of leaving the window over budget", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", thinking: "hmm ".repeat(2000) },
    { role: "assistant", content: "", thinking: "still thinking" },
  ]);
  const failures = [];
  const messages = longTranscript();

  const result = await compactMessages({
    client,
    messages,
    maxChars: 100,
    keepRecent: 4,
    onFailure: (i) => failures.push(i),
  });

  assert.equal(client.calls.length, 2);
  assert.notEqual(result, messages);
  assert.match(result[1].content, /summarizer returned nothing usable/);
  assert.deepEqual(failures, [{ reason: "empty-summary", recovered: true }]);
});

test("an empty first summary that succeeds on retry uses the second reply", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", thinking: "..." },
    { role: "assistant", content: "RETRY SUMMARY" },
  ]);
  const failures = [];
  const messages = longTranscript();

  const result = await compactMessages({
    client,
    messages,
    maxChars: 100,
    keepRecent: 4,
    onFailure: (i) => failures.push(i),
  });

  assert.equal(client.calls.length, 2);
  assert.equal(failures.length, 0);
  assert.match(result[1].content, /RETRY SUMMARY/);
  assert.doesNotMatch(result[1].content, /nothing usable/);
});
test("the summarizer runs with minimal thinking and a hard output cap", async () => {
  const client = new FakeClient([{ role: "assistant", content: "SUMMARY" }]);
  client.model = "gpt-oss:20b";
  await compactMessages({ client, messages: longTranscript(), maxChars: 100 });
  assert.equal(client.calls[0].think, "low");
  assert.equal(client.calls[0].options.num_predict, SUMMARY_MAX_TOKENS);

  const other = new FakeClient([{ role: "assistant", content: "SUMMARY" }]);
  other.model = "qwen3:14b";
  await compactMessages({ client: other, messages: longTranscript(), maxChars: 100 });
  assert.equal(other.calls[0].think, false);
});

test("agent loop counts empty-summary recovery as a failure that still compacted", async () => {
  // Two empty summarizer replies -> stub compact; the model then answers.
  const client = new FakeClient([
    { role: "assistant", content: "", thinking: "..." },
    { role: "assistant", content: "", thinking: "..." },
    { role: "assistant", content: "final" },
  ]);
  const registry = new ToolRegistry();
  const loop = new AgentLoop({ client, registry, compaction: { maxChars: 100, keepRecent: 4 } });

  const result = await loop.run("continue", { history: longTranscript() });

  assert.equal(result.text, "final");
  assert.equal(result.compactions, 1);
  assert.equal(result.compactionFailures, 1);
  assert.ok(result.steps.some((s) => s.kind === "compaction" && /failed \(empty-summary\)/.test(s.content)));
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


test("the summary keeps the original instruction verbatim and points at the history file", async () => {
  const client = new FakeClient([{ role: "assistant", content: "SUMMARY OF OLD TURNS" }]);
  const messages = longTranscript();
  messages[1] = { role: "user", content: `Merge the two branches. ${"x".repeat(500)}` };

  const result = await compactMessages({
    client,
    messages,
    maxChars: 2000,
    keepRecent: 4,
    historyPath: ".bf/bf-agent/sessions/fix.json",
  });

  assert.notEqual(result, messages);
  const recap = result[1].content;
  assert.match(recap, /Original user instruction \(verbatim/);
  assert.match(recap, /Merge the two branches\./);
  assert.match(recap, /SUMMARY OF OLD TURNS/);
  assert.match(recap, /\.bf\/bf-agent\/sessions\/fix\.json/);
  assert.match(recap, /grep_search or read_file/);
  assert.equal(extractOriginalInstruction(result).startsWith("[Earlier conversation"), false);
});

test("without a history file the summary carries no file reference", async () => {
  const client = new FakeClient([{ role: "assistant", content: "SUMMARY" }]);
  const result = await compactMessages({ client, messages: longTranscript(), maxChars: 2000, keepRecent: 4 });
  assert.doesNotMatch(result[1].content, /transcript is saved at/);
});
