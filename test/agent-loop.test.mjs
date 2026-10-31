import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentLoop,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_STEPS,
  DEFAULT_SYSTEM_PROMPT,
  isToolCallParseError,
  emptyRetryPrompt,
  incompleteToolCallPrompt,
  incompleteToolCallText,
  truncatedRetryPrompt,
  TRUNCATED_RETRY_PROMPT,
  parseTextToolCall,
  stripStrayToolCallMarkup,
  repairToolCallParseError,
  toolResultContent,
  WALL_CLOCK_RESERVE_MIN_MS,
} from "../src/agent-loop.mjs";
import { modelPromptOverlay } from "../src/model-tuning.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";

/** Client that replays a scripted sequence of assistant messages. */
class FakeClient {
  constructor(script) {
    this.script = [...script];
    this.calls = [];
  }

  async chat({ messages, tools }) {
    this.calls.push({ messages: structuredClone(messages), tools });
    const message = this.script.shift();
    if (!message) throw new Error("FakeClient script exhausted.");
    return { message, raw: { message } };
  }
}

function makeRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    name: "add",
    description: "Add two numbers.",
    parameters: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
    execute: ({ a, b }) => a + b,
  });
  registry.register({
    name: "explode",
    description: "Always fails.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      throw new Error("boom");
    },
  });
  return registry;
}

const toolCall = (name, args) => ({ function: { name, arguments: args } });

function ollamaError(message, status) {
  const err = new Error(message);
  err.name = "OllamaClientError";
  err.status = status;
  return err;
}

test("system prompt is short and stays out of task specifics", () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /Gather context yourself/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Read a file before editing it/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Verify your work/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /output file path/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /chat answer is not the deliverable/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Communication:/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /final message must[\s\S]*stand alone/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Change only what the task requires/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Only run git commit or git push when the user asked/);
  // The safety line is about intent to harm others; security work on the
  // user's own code must not read as a refusal trigger.
  assert.match(DEFAULT_SYSTEM_PROMPT, /harm others/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /cryptanalysis, CTF-style exercises[\s\S]*is legitimate work/);
  assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /malware, exploits, or other harm/);
  // Task-type text (acceptance criteria, apt-get probes, Goals blocks) lives
  // in rules now, not here.
  assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /Goals:/);
  assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /acceptance/i);
  assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /apt-get/);
  assert.ok(DEFAULT_SYSTEM_PROMPT.length < 2_500, "core prompt stays compact");
  assert.equal(DEFAULT_MAX_STEPS, 100);
});

test("plain answer with no tool calls completes in one step", async () => {
  const client = new FakeClient([{ role: "assistant", content: "hi there" }]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("say hi");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "hi there");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].kind, "final");
  assert.ok(Number.isFinite(result.elapsedMs));
  assert.deepEqual(
    result.messages.map((m) => m.role),
    ["system", "user", "assistant"],
  );
  // No task hints, plans, or extra framing: the user's words go in verbatim.
  assert.equal(client.calls[0].messages[1].content, "say hi");
});

test("tool call round-trip: executes tool, feeds result back, returns final", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 2, b: 3 })] },
    { role: "assistant", content: "The sum is 5." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("what is 2+3?");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "The sum is 5.");
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].kind, "tool-calls");
  const { durationMs, ...call } = result.steps[0].toolCalls[0];
  assert.deepEqual(call, {
    name: "add",
    args: { a: 2, b: 3 },
    ok: true,
    result: 5,
  });
  assert.equal(typeof durationMs, "number", "tool calls carry a duration for efficiency analysis");
  assert.equal(typeof result.steps[0].durationMs, "number", "steps carry the model turn duration");
  assert.equal(result.compactions, 0);

  const toolMsg = client.calls[1].messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "tool result message was sent back to the model");
  assert.equal(toolMsg.tool_name, "add");
  assert.equal(toolMsg.content, "5");

  assert.equal(client.calls[0].tools.length, 2);
  assert.equal(client.calls[0].tools[0].type, "function");
});

test("multiple tool calls in one assistant turn all execute in order", async () => {
  const client = new FakeClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("add", { a: 1, b: 1 }), toolCall("add", { a: 2, b: 2 })],
    },
    { role: "assistant", content: "2 and 4." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("do both");

  assert.equal(result.steps[0].toolCalls.length, 2);
  assert.equal(result.steps[0].toolCalls[0].result, 2);
  assert.equal(result.steps[0].toolCalls[1].result, 4);
  assert.equal(client.calls[1].messages.filter((m) => m.role === "tool").length, 2);
});

test("tool failure is surfaced to the model, loop continues", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("explode", {})] },
    { role: "assistant", content: "That tool failed." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("try it");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.steps[0].toolCalls[0].ok, false);
  assert.match(result.steps[0].toolCalls[0].error, /boom/);
  const toolMsg = client.calls[1].messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /^ERROR: .*boom/);
});

test("unknown tool name is reported back to the model, loop continues", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("nope", {})] },
    { role: "assistant", content: "ok" },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("go");

  assert.equal(result.steps[0].toolCalls[0].ok, false);
  assert.match(result.steps[0].toolCalls[0].error, /nope/);
  assert.equal(result.text, "ok");
});

test("string tool arguments (JSON) are parsed before execution", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", '{"a":4,"b":6}')] },
    { role: "assistant", content: "10." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("add them");

  assert.equal(result.steps[0].toolCalls[0].ok, true);
  assert.equal(result.steps[0].toolCalls[0].result, 10);
});

test("stops at maxSteps and asks for a plain-text wrap-up answer", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "I added twice; the task is not finished." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 2 });

  const result = await loop.run("loop forever");

  assert.equal(result.stopReason, "max-steps");
  assert.equal(result.text, "I added twice; the task is not finished.");
  assert.equal(result.steps.filter((s) => s.kind === "tool-calls").length, 2);
  // Wrap-up call offers no tools and carries the wrap-up instruction.
  const wrapUp = client.calls[2];
  assert.equal(wrapUp.tools, undefined);
  assert.match(wrapUp.messages.at(-1).content, /Do not call any more tools/);
  assert.equal(result.messages.at(-1).content, result.text);
});

test("prompt-token budget: cumulative prompt tokens stop the loop with a wrap-up and stopReason token-budget", async () => {
  // Each call reports 1500 prompt tokens; budget 4000 allows 3 calls (0, 1500,
  // 3000 before each), then the wrap-up call.
  const script = [
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "Out of budget; here is what I have." },
  ];
  const client = {
    calls: [],
    async chat({ messages, tools }) {
      this.calls.push({ messages, tools });
      const message = script.shift();
      return { message, raw: { message, prompt_eval_count: 1500, eval_count: 20 } };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 50, maxPromptTokens: 4000 });

  const result = await loop.run("spend tokens");

  assert.equal(result.stopReason, "token-budget");
  assert.equal(result.steps.filter((s) => s.kind === "tool-calls").length, 3);
  assert.equal(result.promptTokens, 4500);
  assert.equal(result.text, "Out of budget; here is what I have.");
  assert.equal(client.calls.at(-1).tools, undefined, "wrap-up offers no tools");
});

test("steps record cached prompt tokens when the provider reports them", async () => {
  const script = [
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "done" },
  ];
  const usage = [
    { prompt_eval_count: 1000, eval_count: 10 },
    { prompt_eval_count: 1200, prompt_eval_cached_count: 980, eval_count: 5 },
  ];
  const client = {
    async chat() {
      const message = script.shift();
      return { message, raw: { message, ...usage.shift() } };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("go");

  const [first, second] = result.steps;
  assert.equal(first.promptTokens, 1000);
  assert.equal("cachedPromptTokens" in first, false, "omitted when the provider does not report it");
  assert.equal(second.promptTokens, 1200);
  assert.equal(second.cachedPromptTokens, 980);
});

test("prompt-token budget is off by default and ignores providers that report no usage", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "done" },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });
  const result = await loop.run("go");
  assert.equal(result.stopReason, "completed");
  assert.equal(result.promptTokens, 0);
  assert.equal(result.streakNudges, 0);
});

test("streak nudge: N consecutive calls to one read-only tool inject one steer message", async () => {
  const calls = Array.from({ length: 4 }, (_, i) => ({
    role: "assistant",
    content: "",
    tool_calls: [toolCall("add", { a: i, b: 1 })],
  }));
  const client = new FakeClient([...calls, { role: "assistant", content: "ok, answering" }]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    streakNudgeAfter: 3,
    streakNudgeHint: "use multiply_many instead.",
  });

  const result = await loop.run("add a lot");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.streakNudges, 1, "nudged once per streak, not on every call past the threshold");
  const nudges = result.steps.filter((s) => s.kind === "steer" && s.nudge);
  assert.equal(nudges.length, 1);
  assert.deepEqual(nudges[0].nudge, { tool: "add", count: 3 });
  assert.match(nudges[0].content, /called add 3 times in a row/);
  assert.match(nudges[0].content, /use multiply_many instead\./);
  // The nudge is the user message the 4th model call sees right after the 3rd tool result.
  const fourth = client.calls[3].messages;
  assert.equal(fourth.at(-1).role, "user");
  assert.match(fourth.at(-1).content, /called add 3 times/);
  assert.equal(fourth.at(-2).role, "tool");
});

test("streak nudge: mutating tools, failures, and tool switches reset the streak", async () => {
  const registry = makeRegistry();
  registry.register({
    name: "write",
    description: "Mutates.",
    parameters: { type: "object", properties: {} },
    requiresApproval: true,
    execute: () => "written",
  });
  registry.registerAliases({ plus: { target: "add" } });
  const client = new FakeClient([
    // Six writes in a row: legitimate scaffolding, never nudged.
    ...Array.from({ length: 6 }, () => ({ role: "assistant", content: "", tool_calls: [toolCall("write", {})] })),
    // add, add, (alias) plus -> add == streak of 3 -> nudge.
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 2, b: 1 })] },
    { role: "assistant", content: "", tool_calls: [toolCall("plus", { a: 3, b: 1 })] },
    // A failing call breaks the streak; two more adds do not reach 3 again.
    { role: "assistant", content: "", tool_calls: [toolCall("explode", {})] },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 4, b: 1 })] },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 5, b: 1 })] },
    { role: "assistant", content: "done" },
  ]);
  const loop = new AgentLoop({ client, registry, streakNudgeAfter: 3 });

  const result = await loop.run("mixed");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.streakNudges, 1);
  const nudge = result.steps.find((s) => s.kind === "steer" && s.nudge);
  assert.deepEqual(nudge.nudge, { tool: "add", count: 3 });
  assert.equal(nudge.index, 9, "fires after the third add (the alias call), not after any write");
});

test("streak nudge is off unless streakNudgeAfter is set", async () => {
  const client = new FakeClient([
    ...Array.from({ length: 8 }, () => ({ role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] })),
    { role: "assistant", content: "done" },
  ]);
  const result = await new AgentLoop({ client, registry: makeRegistry() }).run("go");
  assert.equal(result.streakNudges, 0);
  assert.equal(result.steps.filter((s) => s.kind === "steer").length, 0);
});

test("wrap-up failure still returns max-steps with empty text", async () => {
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      if (calls === 1) {
        return { message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] }, raw: {} };
      }
      throw ollamaError("Ollama /api/chat returned 404: gone", 404);
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 1 });

  const result = await loop.run("go");

  assert.equal(result.stopReason, "max-steps");
  assert.equal(result.text, "");
  assert.equal(result.steps.length, 1);
});

test("empty assistant turns are re-asked, then stop as empty", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "" },
    { role: "assistant", content: "   " },
    { role: "assistant", content: "" },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("say something");

  assert.equal(result.stopReason, "empty");
  assert.equal(result.text, "");
  assert.match(result.error ?? "", /empty responses/i);
  assert.equal(client.calls.length, 3);
  const retries = client.calls[2].messages.filter((m) => m.role === "user" && /was empty/.test(m.content));
  assert.equal(retries.length, 2);
  // Every empty round-trip is visible in the trace, not just the last one.
  assert.deepEqual(result.steps.map((s) => s.kind), ["empty", "empty", "empty"]);
  assert.equal(result.truncatedTurns, 0);
});

test("a turn cut off by the output limit is re-asked with minimal thinking", async () => {
  const requests = [];
  const client = {
    model: "gpt-oss:20b",
    async chat(request) {
      requests.push({ think: request.think, lastUser: request.messages.at(-1), messages: structuredClone(request.messages), options: request.options });
      if (requests.length === 1) {
        // Thinking ran the context window dry: no text, no tool call.
        return {
          message: { role: "assistant", content: "", thinking: "let me consider... ".repeat(500) },
          raw: { done_reason: "length", prompt_eval_count: 3000, eval_count: 13000 },
        };
      }
      return {
        message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 2, b: 3 })] },
        raw: { done_reason: "stop" },
      };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 2 });

  const result = await loop.run("add them");

  assert.equal(requests[0].think, undefined, "first call uses the client default");
  assert.equal(requests[0].options.num_predict, DEFAULT_MAX_OUTPUT_TOKENS, "every call carries the output cap");
  assert.match(requests[1].lastUser.content, /cut off by the output limit/);
  assert.equal(requests[1].think, "low", "gpt-oss retry drops to the low thinking level");
  assert.ok(
    !requests[1].messages.some((m) => m.role === "assistant" && /let me consider/.test(m.thinking ?? "")),
    "the cut-off turn's partial thinking is not re-sent",
  );
  assert.ok(
    !result.messages.some((m) => m.role === "assistant" && /let me consider/.test(m.thinking ?? "")),
    "nor kept in the transcript",
  );
  assert.equal(result.truncatedTurns, 1);
  assert.equal(result.model, "gpt-oss:20b");
  assert.equal(result.steps[0].kind, "empty");
  assert.equal(result.steps[0].truncated, true);
  assert.equal(result.steps[0].completionTokens, 13000);
  assert.equal(result.steps[1].kind, "tool-calls");
  assert.equal(result.steps[1].truncated, undefined);
});

test("maxOutputTokens: 0 sends no num_predict cap", async () => {
  let seen;
  const client = {
    async chat(request) {
      seen = request.options;
      return { message: { role: "assistant", content: "ok" }, raw: {} };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxOutputTokens: 0 });
  await loop.run("hi");
  assert.equal(seen, undefined);
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 12_000);
});

test("non-gpt-oss thinking models get think:false on the truncated retry", async () => {
  const thinks = [];
  const client = {
    model: "qwen3:14b",
    async chat(request) {
      thinks.push(request.think);
      if (thinks.length === 1) {
        return { message: { role: "assistant", content: "" }, raw: { done_reason: "length" } };
      }
      return { message: { role: "assistant", content: "done" }, raw: {} };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("go");

  assert.deepEqual(thinks, [undefined, false]);
  assert.equal(result.text, "done");
  assert.equal(result.stopReason, "completed");
});

test("transient client errors are retried", async () => {
  const flaky = {
    attempts: 0,
    async chat() {
      this.attempts++;
      if (this.attempts === 1) throw ollamaError("Cannot reach Ollama", null);
      return { message: { role: "assistant", content: "recovered" }, raw: {} };
    },
  };
  const loop = new AgentLoop({ client: flaky, registry: makeRegistry() });

  const result = await loop.run("go");

  assert.equal(result.text, "recovered");
  assert.equal(flaky.attempts, 2);
});

test("client errors with a 4xx status are not retried", async () => {
  const failing = {
    attempts: 0,
    async chat() {
      this.attempts++;
      throw ollamaError("model not found", 404);
    },
  };
  const loop = new AgentLoop({ client: failing, registry: makeRegistry() });

  await assert.rejects(() => loop.run("go"), /model not found/);
  assert.equal(failing.attempts, 1);
});

test("tool-call parse 500s are nudged and recovered", async () => {
  let phase = 0;
  const client = {
    async chat({ messages }) {
      phase++;
      if (phase === 1) {
        throw ollamaError(
          `Ollama /api/chat returned 500: {"error":"error parsing tool call: raw='thinking...{\\"pattern\\":\\"x\\"}"}`,
          500,
        );
      }
      if (phase === 2) {
        const nudged = messages.some((m) => m.role === "user" && /could not be parsed as a tool call/i.test(m.content ?? ""));
        assert.ok(nudged, "expected a parse-recovery nudge in messages");
        return { message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] }, raw: {} };
      }
      return { message: { role: "assistant", content: "3" }, raw: {} };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("add 1 and 2");

  assert.equal(result.text, "3");
  const parseStep = result.steps.find((s) => s.kind === "tool-parse-error");
  assert.ok(parseStep, "expected a logged tool-parse-error step");
  assert.match(parseStep.content, /error parsing tool call/i);
  assert.equal(result.steps.find((s) => s.kind === "tool-calls").toolCalls[0].result, 3);
  assert.equal(phase, 3);
});

test("tool-call parse errors exhaust recoveries then throw", async () => {
  const failing = {
    attempts: 0,
    async chat() {
      this.attempts++;
      throw ollamaError('Ollama /api/chat returned 500: {"error":"error parsing tool call: raw=\'x\'"}', 500);
    },
  };
  const loop = new AgentLoop({ client: failing, registry: makeRegistry() });

  await assert.rejects(() => loop.run("go"), /error parsing tool call/);
  assert.equal(failing.attempts, 3);
});

// Captured from gpt-oss:20b via Ollama: a long script argument closed with `"]`.
const STRAY_BRACKET_RAW =
  `{"command":"python3 - <<'PY'\\nimport sys\\nfrom pathlib import Path\\nseq=Path('sequences.fasta').read_text().splitlines()[1]\\nprint(seq[:20])\\nPY"],"cwd":"/app","timeout_seconds":120}`;
const strayBracketError = () =>
  ollamaError(
    `Ollama /api/chat returned 500: error parsing tool call: raw='${STRAY_BRACKET_RAW}', err=invalid character ']' after object key:value pair`,
    500,
  );
const shellSchemas = () => [
  {
    type: "function",
    function: {
      name: "run_command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, cwd: { type: "string" }, timeout_seconds: { type: "number" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      parameters: { type: "object", properties: { path: {}, content: {} }, required: ["path", "content"] },
    },
  },
];

test("repairToolCallParseError drops a single stray ] and resolves the tool by schema", () => {
  const repaired = repairToolCallParseError(strayBracketError(), shellSchemas());
  assert.equal(repaired.name, "run_command");
  assert.equal(repaired.arguments.cwd, "/app");
  assert.equal(repaired.arguments.timeout_seconds, 120);
  assert.match(repaired.arguments.command, /^python3 - <<'PY'\nimport sys\n/);
  assert.match(repaired.arguments.command, /\[1\]\nprint\(seq\[:20\]\)\nPY$/);
});

test("repairToolCallParseError refuses ambiguous or unrelated damage", () => {
  // Different parse error: unescaped quote / concatenation — not repairable.
  assert.equal(
    repairToolCallParseError(
      ollamaError(`Ollama /api/chat returned 500: error parsing tool call: raw='{"command":"x"+y"}', err=invalid character '+' after object key:value pair`, 500),
      shellSchemas(),
    ),
    null,
  );
  // Two stray brackets: ambiguous.
  assert.equal(
    repairToolCallParseError(
      ollamaError(`Ollama /api/chat returned 500: error parsing tool call: raw='{"command":"a"],"cwd":"b"]}', err=invalid character ']' after object key:value pair`, 500),
      shellSchemas(),
    ),
    null,
  );
  // Keys fit no registered tool.
  assert.equal(
    repairToolCallParseError(
      ollamaError(`Ollama /api/chat returned 500: error parsing tool call: raw='{"pattern":"a"]}', err=invalid character ']' after object key:value pair`, 500),
      shellSchemas(),
    ),
    null,
  );
  // Keys fit more than one tool.
  const overlapping = [
    { type: "function", function: { name: "t1", parameters: { properties: { x: {} }, required: ["x"] } } },
    { type: "function", function: { name: "t2", parameters: { properties: { x: {}, y: {} }, required: [] } } },
  ];
  assert.equal(
    repairToolCallParseError(
      ollamaError(`Ollama /api/chat returned 500: error parsing tool call: raw='{"x":"a"]}', err=invalid character ']' after object key:value pair`, 500),
      overlapping,
    ),
    null,
  );
});

test("a repairable parse error executes the tool without a correction round-trip", async () => {
  const registry = new ToolRegistry();
  const seen = [];
  registry.register({
    name: "run_command",
    description: "run",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, cwd: { type: "string" }, timeout_seconds: { type: "number" } },
      required: ["command"],
    },
    execute: (args) => {
      seen.push(args);
      return { exitCode: 0, stdout: "actcttcctttttcaatatt" };
    },
  });
  let phase = 0;
  const client = {
    async chat({ messages }) {
      phase++;
      if (phase === 1) throw strayBracketError();
      assert.ok(
        !messages.some((m) => m.role === "user" && /could not be parsed/i.test(m.content ?? "")),
        "repaired calls must not push the parse nudge",
      );
      const toolMsg = messages.filter((m) => m.role === "tool").at(-1);
      assert.match(toolMsg.content, /actcttcc/);
      return { message: { role: "assistant", content: "done" }, raw: {} };
    },
  };
  const loop = new AgentLoop({ client, registry });

  const result = await loop.run("compare the sequences");

  assert.equal(result.text, "done");
  assert.equal(phase, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cwd, "/app");
  const parseStep = result.steps.find((s) => s.kind === "tool-parse-error");
  assert.equal(parseStep.repaired, "run_command");
  assert.equal(parseStep.recoveries, 0);
  const callStep = result.steps.find((s) => s.kind === "tool-calls");
  assert.equal(callStep.toolCalls[0].name, "run_command");
  assert.equal(callStep.toolCalls[0].result.stdout, "actcttcctttttcaatatt");
});

test("parseTextToolCall reads qwen3-coder's XML form and the name+arguments JSON form", () => {
  // Verbatim from a qwen3-coder:30b trace: the loop had accepted this as the final answer.
  const xml = "<function=read_file>\n<parameter=path>\noutput_seq.txt\n</parameter>\n</function>\n</tool_call>";
  assert.deepEqual(parseTextToolCall(xml, shellSchemas().concat(readSchema())), {
    name: "read_file",
    arguments: { path: "output_seq.txt" },
  });
  const typed = "<tool_call><function=run_command><parameter=command>ls -la</parameter><parameter=timeout_seconds>30</parameter></function></tool_call>";
  assert.deepEqual(parseTextToolCall(typed, shellSchemas()), {
    name: "run_command",
    arguments: { command: "ls -la", timeout_seconds: 30 },
  });
  assert.deepEqual(parseTextToolCall('{"name":"run_command","arguments":{"command":"pwd"}}', shellSchemas()), {
    name: "run_command",
    arguments: { command: "pwd" },
  });
  // Not calls: prose, unknown tool, bare args (could be a JSON deliverable).
  assert.equal(parseTextToolCall("I'll read the file next.", shellSchemas()), null);
  assert.equal(parseTextToolCall("<function=nope><parameter=x>1</parameter></function>", shellSchemas()), null);
  assert.equal(parseTextToolCall('{"command":"pwd"}', shellSchemas()), null);
  assert.equal(parseTextToolCall("Done. <function=read_file><parameter=path>a</parameter></function>", shellSchemas()), null);
});

test("parseTextToolCall dispatches a preamble plus one function block", () => {
  const searchSchema = {
    type: "function",
    function: {
      name: "symbol_search",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, kind: { type: "string" } },
        required: ["pattern"],
      },
    },
  };
  const findExport = [
    "I need to find which file exports the function `computeTax`. Let me search for this symbol across the codebase.",
    "",
    "<function=symbol_search>",
    "<parameter=pattern>",
    "^computeTax$",
    "</parameter>",
    "<parameter=kind>",
    "function",
    "</parameter>",
    "</function>",
  ].join("\n");
  assert.deepEqual(parseTextToolCall(findExport, [searchSchema]), {
    name: "symbol_search",
    arguments: { pattern: "^computeTax$", kind: "function" },
  });
  const pyFind = [
    "I need to find the function named `compute_tax` in the workspace. Let me search for it using the appropriate tool.",
    "",
    "<function=symbol_search>",
    "<parameter=pattern>",
    "compute_tax",
    "</parameter>",
    "</function>",
  ].join("\n");
  assert.deepEqual(parseTextToolCall(pyFind, [searchSchema]), {
    name: "symbol_search",
    arguments: { pattern: "compute_tax" },
  });
  assert.equal(
    parseTextToolCall("lib/tax.mjs\n<function=symbol_search><parameter=pattern>computeTax</parameter></function>", [searchSchema]),
    null,
  );
  assert.equal(
    parseTextToolCall(
      "<function=symbol_search><parameter=pattern>computeTax</parameter></function>\nlib/tax.mjs",
      [searchSchema],
    ),
    null,
  );
  assert.equal(
    parseTextToolCall(
      "I need to find it.\n<function=nope><parameter=pattern>computeTax</parameter></function>",
      [searchSchema],
    ),
    null,
  );
});

test("incompleteToolCallText is an unclosed marker, not a balanced example", () => {
  assert.equal(
    incompleteToolCallText("First, I'll create the product controller with proper CRUD operations:<tool_call>"),
    true,
  );
  assert.equal(incompleteToolCallText("<function=read_file>\n<parameter=path>\na.ts"), true);
  assert.equal(
    incompleteToolCallText("<tool_call><function=read_file><parameter=path>a.ts</parameter></function></tool_call>"),
    false,
  );
  assert.equal(incompleteToolCallText("Use a </tool_call> only after <tool_call>."), false);
  assert.equal(incompleteToolCallText("I'll read the file next."), false);
  assert.equal(
    incompleteToolCallText(
      "I'll start by cleaning up main.js <tool_call> see that I need to modify the existing files rather than create new ones.",
    ),
    false,
  );
  // A finished multi-sentence answer that merely appends a bare <tool_call>
  // at the very end (qwen3-coder's trailing leak) is a leak, not a cutoff.
  assert.equal(
    incompleteToolCallText(
      "I finished the task and saved the output to results.txt. I examined the binary and ran it with several inputs. " +
        "I read the generated file and verified its contents. The file now holds the final result as requested.<tool_call>",
    ),
    false,
  );
});

test("stripStrayToolCallMarkup removes a leaked tag and leaves the sentence", () => {
  assert.equal(
    stripStrayToolCallMarkup(
      "implementing the complete game logic in it <tool_call> see that I need to modify the existing files.",
    ),
    "implementing the complete game logic in it see that I need to modify the existing files.",
  );
});

test("a stray tool_call tag inside a finished answer is removed and not retried", async () => {
  const requests = [];
  const leaked =
    "I'll start by cleaning up main.js <tool_call> see that I need to modify the existing files rather than create new ones. The game is ready.";
  const client = {
    async chat(request) {
      requests.push(structuredClone(request.messages));
      return { message: { role: "assistant", content: leaked }, raw: { done_reason: "stop" } };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 4 });

  const result = await loop.run("create a playable 3d game");

  assert.equal(requests.length, 1);
  assert.equal(result.stopReason, "completed");
  assert.doesNotMatch(result.text, /<tool_call>/);
  assert.match(result.text, /The game is ready/);
});

test("a finished answer that ends on a bare tool_call token is accepted, not retried", async () => {
  const requests = [];
  const answer =
    "I finished the task and saved the output to results.txt. I examined the binary and ran it with several inputs. " +
    "I read the generated file and verified its contents. The file now holds the final result as requested.<tool_call>";
  const client = {
    model: "qwen3-coder:30b",
    async chat(request) {
      requests.push(structuredClone(request.messages));
      return { message: { role: "assistant", content: answer }, raw: { done_reason: "stop" } };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 4 });

  const result = await loop.run("extract the secret key");

  assert.equal(requests.length, 1, "the trailing leaked token did not trigger an empty-retry spin");
  assert.equal(result.stopReason, "completed");
  assert.doesNotMatch(result.text, /<tool_call>/);
  assert.match(result.text, /final result as requested/);
});

test("a reply that ends on an unclosed tool_call token is retried, not accepted as final", async () => {
  const requests = [];
  const client = {
    model: "qwen3-coder:30b",
    async chat(request) {
      requests.push(structuredClone(request.messages));
      if (requests.length === 1) {
        return {
          message: {
            role: "assistant",
            content: "First, I'll create the product controller with proper CRUD operations:<tool_call>",
          },
          raw: { done_reason: "stop" },
        };
      }
      return { message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] }, raw: {} };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 3 });

  const result = await loop.run("go");

  assert.equal(result.steps[0].kind, "empty");
  assert.equal(result.steps[0].truncated, undefined, "stopping on the call token is not an output-limit truncation");
  assert.equal(result.truncatedTurns, 0);
  assert.match(result.steps[0].content, /<tool_call>/);
  assert.match(requests[1].at(-1).content, /close it with <\/tool_call>/);
  assert.doesNotMatch(requests[1].at(-1).content, /Do not write <tool_call>/);
  assert.match(incompleteToolCallPrompt("llama3.1"), /native tool calling/);
  assert.match(modelPromptOverlay("qwen3-coder:30b"), /<\/tool_call>/);
  assert.match(modelPromptOverlay("llama3.1"), /JSON/);
  assert.ok(
    !requests[1].some((m) => m.role === "assistant" && /<tool_call>/.test(String(m.content ?? ""))),
    "the cut-off call is not re-sent",
  );
  assert.equal(result.steps[1].kind, "tool-calls");
});

test("incomplete tool-call cutoffs separated by a real call do not exhaust the retry budget", async () => {
  const cutoff = "I'll scan the files next:<tool_call>";
  let n = 0;
  const client = {
    model: "qwen3-coder:30b",
    async chat() {
      n += 1;
      if (n === 1 || n === 3 || n === 5) {
        return {
          message: { role: "assistant", content: cutoff },
          raw: { done_reason: "stop", eval_count: 160, prompt_eval_count: 12000 },
        };
      }
      if (n === 6) {
        return { message: { role: "assistant", content: "done" }, raw: { done_reason: "stop" } };
      }
      return {
        message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
        raw: { done_reason: "stop" },
      };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 8 });

  const result = await loop.run("go");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "done");
  assert.equal(result.truncatedTurns, 0);
  assert.equal(result.steps.filter((s) => s.kind === "empty").length, 3);
  assert.equal(n, 6);
});

function readSchema() {
  return {
    type: "function",
    function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  };
}

test("a tool call written as text is executed instead of ending the turn", async () => {
  let phase = 0;
  const client = {
    async chat({ messages }) {
      phase++;
      if (phase === 1) {
        return {
          message: { role: "assistant", content: "<function=add>\n<parameter=a>\n2\n</parameter>\n<parameter=b>\n3\n</parameter>\n</function>" },
          raw: {},
        };
      }
      const echoed = messages.filter((m) => m.role === "assistant").at(-1);
      assert.equal(echoed.content, "", "the text form is replaced by a real tool_calls message in the transcript");
      assert.equal(echoed.tool_calls[0].function.name, "add");
      assert.equal(messages.at(-1).role, "tool");
      return { message: { role: "assistant", content: "5" }, raw: {} };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("add 2 and 3");

  assert.equal(result.text, "5");
  assert.equal(phase, 2);
  const parseStep = result.steps.find((s) => s.kind === "tool-parse-error");
  assert.equal(parseStep.repaired, "add");
  assert.match(parseStep.content, /written as text/);
  const callStep = result.steps.find((s) => s.kind === "tool-calls");
  assert.equal(callStep.toolCalls[0].result, 5, "XML parameter values were coerced to the schema's number type");
});

test("a content-only turn cut off by the output limit is retried, not accepted as final", async () => {
  const requests = [];
  const client = {
    model: "qwen3-coder:30b",
    async chat(request) {
      requests.push(structuredClone(request.messages));
      if (requests.length === 1) {
        return {
          message: { role: "assistant", content: "Here is the script:\n" + "print(1)\n".repeat(2000) },
          raw: { done_reason: "length", eval_count: 12000 },
        };
      }
      return { message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] }, raw: {} };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 2 });

  const result = await loop.run("go");

  assert.equal(result.truncatedTurns, 1);
  assert.equal(result.steps[0].kind, "empty");
  assert.equal(result.steps[0].truncated, true);
  assert.match(result.steps[0].content, /^Here is the script/, "the cut-off text is kept in the trace");
  assert.match(requests[1].at(-1).content, /cut off by the output limit/);
  assert.match(requests[1].at(-1).content, /single tool call only/, "demands a tool call, not more prose");
  assert.doesNotMatch(requests[1].at(-1).content, /Only if the task needs no tool/);
  assert.ok(!requests[1].some((m) => /print\(1\)/.test(m.content ?? "")), "the cut-off text is not re-sent");
  assert.equal(result.steps[1].kind, "tool-calls");
});

test("truncatedRetryPrompt names missing deliverables and demands write_file", () => {
  assert.equal(truncatedRetryPrompt({ goal: "say hi", steps: [] }), TRUNCATED_RETRY_PROMPT);
  const withPath = truncatedRetryPrompt({
    goal: "Write the solution to /app/attack.py and run it.",
    steps: [],
  });
  assert.match(withPath, /\/app\/attack\.py/);
  assert.match(withPath, /write_file/);
  assert.match(withPath, /one write_file tool call only/);
  assert.doesNotMatch(withPath, /plain text/);
});

test("truncated retry with a missing deliverable steers write_file for that path", async () => {
  const requests = [];
  const client = {
    model: "glm-5.3-flash:cloud",
    async chat(request) {
      requests.push(request.messages.at(-1));
      if (requests.length === 1) {
        return {
          message: { role: "assistant", content: "Let me analyze FEAL-4... ".repeat(400) },
          raw: { done_reason: "length", eval_count: 12000 },
        };
      }
      return {
        message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
        raw: {},
      };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 3 });

  await loop.run("Recover the key. Write /app/attack.py with your solution.");

  assert.match(requests[1].content, /\/app\/attack\.py/);
  assert.match(requests[1].content, /write_file/);
  assert.equal(requests[1].role, "user");
});

test("emptyRetryPrompt names missing deliverables", () => {
  assert.match(emptyRetryPrompt({ goal: "hi", steps: [] }), /Call a tool now/);
  assert.match(
    emptyRetryPrompt({ goal: "Write results to /app/out.txt", steps: [] }),
    /\/app\/out\.txt/,
  );
});

test("isToolCallParseError detects Ollama parse failures", () => {
  assert.equal(
    isToolCallParseError(ollamaError('Ollama /api/chat returned 500: {"error":"error parsing tool call: raw=\'x\'"}', 500)),
    true,
  );
  assert.equal(isToolCallParseError(ollamaError("Ollama /api/chat returned 500: boom", 500)), false);
});

test("mid-run model-call failure ends as a failed run with the work preserved", async () => {
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      if (calls === 1) {
        return { message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] }, raw: {} };
      }
      throw ollamaError("Ollama stream failed mid-response: body timeout", 404);
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("say hi");

  assert.equal(result.stopReason, "failed");
  assert.match(result.error, /model call failed/i);
  assert.ok(result.steps.some((s) => s.kind === "failed"));
  assert.ok(result.steps.some((s) => s.kind === "tool-calls"), "completed work survives in the trajectory");
});

test("startup model-call failure still propagates for exit-code mapping", async () => {
  const client = {
    async chat() {
      throw ollamaError("Ollama /api/chat returned 404: model missing", 404);
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  await assert.rejects(loop.run("say hi"), /model missing/);
});

test("history continues a prior transcript without a new system message", async () => {
  const client = new FakeClient([{ role: "assistant", content: "again: hi" }]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const history = [
    { role: "system", content: "custom system" },
    { role: "user", content: "say hi" },
    { role: "assistant", content: "hi" },
  ];
  const result = await loop.run("say it again", { history });

  assert.equal(result.text, "again: hi");
  const sent = client.calls[0].messages;
  assert.equal(sent[0].content, "custom system");
  assert.equal(sent.filter((m) => m.role === "system").length, 1);
  assert.equal(history.length, 3);
});

test("images ride on the new user message", async () => {
  const client = new FakeClient([{ role: "assistant", content: "a cat" }]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  await loop.run("what is this?", { images: ["QUJD"] });

  const user = client.calls[0].messages.find((m) => m.role === "user");
  assert.deepEqual(user.images, ["QUJD"]);
});

test("onStep observer fires for every step", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] },
    { role: "assistant", content: "3." },
  ]);
  const seen = [];
  const loop = new AgentLoop({ client, registry: makeRegistry(), onStep: (step) => seen.push(step.kind) });

  await loop.run("add");

  assert.deepEqual(seen, ["tool-calls", "final"]);
});

test("aborted signal stops before calling the model", async () => {
  const client = new FakeClient([{ role: "assistant", content: "never" }]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });
  const controller = new AbortController();
  controller.abort();

  const result = await loop.run("go", { signal: controller.signal });

  assert.equal(result.stopReason, "aborted");
  assert.equal(client.calls.length, 0);
});

test("the goal and deadline are handed to the registry as run context", async () => {
  const client = new FakeClient([{ role: "assistant", content: "ok" }]);
  const registry = makeRegistry();
  const contexts = [];
  registry.setRunContext = (ctx) => contexts.push(ctx);
  const loop = new AgentLoop({ client, registry, wallClockMs: 60_000, now: () => 1_000 });

  await loop.run("delete tmp.txt");

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].goal, "delete tmp.txt");
  assert.equal(contexts[0].deadlineAt, 61_000);
});

// --- hooks -------------------------------------------------------------------

test("beforeToolCall can block a tool; the reason goes back to the model", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("explode", {})] },
    { role: "assistant", content: "blocked, ok" },
  ]);
  let executed = false;
  const registry = makeRegistry();
  registry.register({
    name: "spy",
    description: "",
    parameters: { type: "object", properties: {} },
    execute: () => {
      executed = true;
    },
  });
  const seen = [];
  const loop = new AgentLoop({
    client,
    registry,
    hooks: {
      beforeToolCall: ({ name, args, step, goal }) => {
        seen.push({ name, args, step, goal });
        if (name === "explode") return { block: "policy: explode is not allowed here" };
      },
    },
  });

  const result = await loop.run("run it");

  assert.deepEqual(seen, [{ name: "explode", args: {}, step: 1, goal: "run it" }]);
  assert.equal(executed, false);
  assert.equal(result.steps[0].toolCalls[0].ok, false);
  assert.match(result.steps[0].toolCalls[0].error, /policy: explode/);
  const toolMsg = client.calls[1].messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.content, "ERROR: policy: explode is not allowed here");
});

test("afterToolCall can annotate a tool result", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] },
    { role: "assistant", content: "3" },
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    hooks: {
      afterToolCall: ({ name, outcome }) => {
        if (name === "add" && outcome.ok) return { note: "remember to verify" };
      },
    },
  });

  const result = await loop.run("add");

  assert.equal(result.steps[0].toolCalls[0].note, "remember to verify");
  const toolMsg = client.calls[1].messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.content, "3\n[note: remember to verify]");
});

test("stop hook can send a follow-up and keep the turn going, bounded by maxStopHookLoops", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "done?" },
    { role: "assistant", content: "done??" },
    { role: "assistant", content: "done!!!" },
  ]);
  const stops = [];
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    maxStopHookLoops: 2,
    hooks: {
      stop: ({ text, loopCount, steps }) => {
        stops.push({ text, loopCount, steps: steps.length });
        return { followupMessage: "Tests have not been run yet. Run them." };
      },
    },
  });

  const result = await loop.run("fix it");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "done!!!");
  assert.deepEqual(
    stops.map((s) => s.loopCount),
    [0, 1],
  );
  assert.equal(result.steps.filter((s) => s.kind === "final" && s.continued).length, 2);
  const followups = client.calls[2].messages.filter((m) => m.role === "user" && /Run them/.test(m.content));
  assert.equal(followups.length, 2);
});

test("stop hook returning nothing ends the turn", async () => {
  const client = new FakeClient([{ role: "assistant", content: "finished" }]);
  let called = 0;
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    hooks: {
      stop: () => {
        called += 1;
      },
    },
  });

  const result = await loop.run("go");

  assert.equal(called, 1);
  assert.equal(result.text, "finished");
  assert.equal(client.calls.length, 1);
});

// --- steer / queue -----------------------------------------------------------

test("steer() lands as a user message right after the next tool results", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "switched" },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });
  loop.steer("actually use b=5");

  const result = await loop.run("add");

  const sent = client.calls[1].messages;
  const toolIdx = sent.findIndex((m) => m.role === "tool");
  assert.equal(sent[toolIdx + 1].role, "user");
  assert.equal(sent[toolIdx + 1].content, "actually use b=5");
  assert.ok(result.steps.some((s) => s.kind === "steer" && s.content === "actually use b=5"));
});

test("steer() during a turn with no tool calls is not delivered", async () => {
  const client = new FakeClient([{ role: "assistant", content: "plain" }]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });
  loop.steer("later");

  const result = await loop.run("hi");

  assert.equal(result.text, "plain");
  assert.equal(client.calls.length, 1);
});

test("queue() runs a follow-up turn with the full conversation after the first completes", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "first done" },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 2, b: 2 })] },
    { role: "assistant", content: "second done: 4" },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), maxSteps: 2 });
  loop.queue("now add 2 and 2");

  const result = await loop.run("first task");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "second done: 4");
  assert.deepEqual(
    result.messages.map((m) => m.role),
    ["system", "user", "assistant", "user", "assistant", "tool", "assistant"],
  );
  assert.equal(result.messages[3].content, "now add 2 and 2");
  // The step budget resets per queued turn: 1 + 2 steps fit under maxSteps=2.
  assert.equal(result.steps.filter((s) => s.kind === "final").length, 2);
});

// --- wall clock --------------------------------------------------------------

test("wall-clock budget: the loop stops itself at the deadline reserve and wraps up", async () => {
  let clock = 0;
  const now = () => clock;
  const client = {
    calls: 0,
    async chat({ tools }) {
      this.calls += 1;
      clock += 1_000; // each model turn costs 1s
      if (!tools) return { message: { role: "assistant", content: "out of time; here is what I did" }, raw: {} };
      return { message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] }, raw: {} };
    },
  };
  // Budget 45s, reserve floors at WALL_CLOCK_RESERVE_MIN_MS → about 15s of real work.
  const loop = new AgentLoop({ client, registry: makeRegistry(), wallClockMs: 45_000, now });

  const result = await loop.run("busy work");

  assert.equal(result.stopReason, "max-steps");
  assert.equal(result.wallClockExhausted, true);
  assert.equal(result.text, "out of time; here is what I did");
  assert.equal(WALL_CLOCK_RESERVE_MIN_MS, 30_000);
  const toolTurns = result.steps.filter((s) => s.kind === "tool-calls").length;
  assert.ok(toolTurns >= 12 && toolTurns <= 18, `stopped after ${toolTurns} turns`);
  assert.ok(result.elapsedMs <= 45_000);
});

test("wall-clock budget: a wrap-up that cannot fit is skipped", async () => {
  let clock = 0;
  const now = () => clock;
  const client = {
    async chat({ tools }) {
      clock += 10_000; // each turn costs 10s — the reserve cannot hold one
      if (!tools) throw new Error("wrap-up should not be attempted");
      return { message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] }, raw: {} };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), wallClockMs: 30_000, now });

  const result = await loop.run("busy work");

  assert.equal(result.stopReason, "max-steps");
  assert.equal(result.wallClockExhausted, true);
  assert.equal(result.text, "");
});

test("wall-clock budget: a hung model turn is aborted so wrap-up can still run", async () => {
  let clock = 1_000;
  const client = {
    calls: 0,
    async chat({ signal, tools }) {
      this.calls += 1;
      if (tools) {
        // Simulate a cloud model that never returns until the turn timer fires.
        await new Promise((_, reject) => {
          const fail = () => {
            // Leave several seconds on the wall clock so wrap-up can run.
            clock += 10_000;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          };
          if (signal?.aborted) return fail();
          signal.addEventListener("abort", fail, { once: true });
        });
      }
      return { message: { role: "assistant", content: "wrapped after hang" }, raw: {} };
    },
  };
  // 45s budget → 30s reserve → ~15s turn timer. After abort (+10s fake), wrap-up still fits.
  const loop = new AgentLoop({ client, registry: makeRegistry(), wallClockMs: 45_000, now: () => clock });

  const result = await loop.run("investigate the archive");

  assert.equal(result.wallClockExhausted, true);
  assert.equal(result.stopReason, "max-steps");
  assert.equal(result.text, "wrapped after hang");
  assert.ok(result.steps.some((s) => s.kind === "failed" && /wall-clock budget reached/.test(s.content)));
  assert.ok(result.steps.some((s) => s.kind === "final" && s.wrapUp));
});
// --- compaction ---------------------------------------------------------------

test("compaction runs before each model call when enabled", async () => {
  const client = {
    calls: 0,
    async chat({ messages }) {
      this.calls += 1;
      if (/compress an agent's conversation/i.test(messages[0]?.content ?? "")) {
        return { message: { role: "assistant", content: "SUMMARY" }, raw: {} };
      }
      if (this.calls === 1) {
        return { message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] }, raw: {} };
      }
      return { message: { role: "assistant", content: "done" }, raw: {} };
    },
  };
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    compaction: { maxChars: 10, keepRecent: 1 },
  });

  const result = await loop.run("x".repeat(50));

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "done");
  assert.ok(result.messages.some((m) => /SUMMARY/.test(String(m.content ?? ""))), "transcript was summarized");
  const trace = result.steps.filter((s) => s.kind === "compaction");
  assert.equal(trace.length, 1);
  assert.match(trace[0].content, /^ok: \d+ -> \d+ messages/);
});

test("a failed compaction is traced with its reason and recovers with a stub", async () => {
  let summarizerCalls = 0;
  const client = {
    calls: 0,
    async chat({ messages }) {
      if (/compress an agent's conversation/i.test(messages[0]?.content ?? "")) {
        summarizerCalls += 1;
        // First attempt empty; second attempt 500 — both count as one failed
        // compaction that still stubs so the window shrinks.
        if (summarizerCalls % 2 === 1) return { message: { role: "assistant", content: "" }, raw: {} };
        throw ollamaError("Ollama /api/chat returned 500: boom", 500);
      }
      this.calls += 1;
      if (this.calls <= 2) {
        return { message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] }, raw: {} };
      }
      return { message: { role: "assistant", content: "done" }, raw: {} };
    },
  };
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    compaction: { maxChars: 10, keepRecent: 1 },
  });

  const result = await loop.run("x".repeat(50));

  assert.equal(result.stopReason, "completed");
  assert.ok(result.compactions >= 1);
  assert.ok(result.compactionFailures >= 1);
  const trace = result.steps.filter((s) => s.kind === "compaction").map((s) => s.content);
  assert.ok(trace.length >= 1);
  assert.match(trace[0], /^failed \(summarizer-error\): Ollama \/api\/chat returned 500: boom; recovered with stub/);
});
// --- toolResultContent -------------------------------------------------------

test("toolResultContent renders command results with a status header", () => {
  const ok = toolResultContent({ ok: true, result: { exitCode: 0, stdout: "hi", stderr: "" } });
  assert.match(ok, /^status: success\nexitCode: 0\nstdout:\nhi$/);

  const failed = toolResultContent({ ok: true, result: { exitCode: 2, stdout: "", stderr: "bad" } });
  assert.match(failed, /status: FAILED with exit code 2/);
  assert.match(failed, /stderr:\nbad/);

  assert.equal(toolResultContent({ ok: true, result: null }), "(no output)");
  assert.equal(toolResultContent({ ok: true, result: { a: 1 } }), '{"a":1}');
  assert.equal(toolResultContent({ ok: false, error: "nope" }), "ERROR: nope");
});
