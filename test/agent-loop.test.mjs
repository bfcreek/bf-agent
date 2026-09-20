import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentLoop,
  DEFAULT_MAX_STEPS,
  DEFAULT_SYSTEM_PROMPT,
  isToolCallParseError,
  toolResultContent,
  WALL_CLOCK_RESERVE_MIN_MS,
} from "../src/agent-loop.mjs";
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
  assert.match(DEFAULT_SYSTEM_PROMPT, /Communication:/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /final message must[\s\S]*stand alone/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Change only what the task requires/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Only run git commit or git push when the user asked/);
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

test("empty assistant turns are re-asked, then accepted", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "" },
    { role: "assistant", content: "   " },
    { role: "assistant", content: "" },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("say something");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "");
  assert.equal(client.calls.length, 3);
  const retries = client.calls[2].messages.filter((m) => m.role === "user" && /was empty/.test(m.content));
  assert.equal(retries.length, 2);
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
  // Budget 20s, reserve is clamped up to 15s → about 5s of real work.
  const loop = new AgentLoop({ client, registry: makeRegistry(), wallClockMs: 20_000, now });

  const result = await loop.run("busy work");

  assert.equal(result.stopReason, "max-steps");
  assert.equal(result.wallClockExhausted, true);
  assert.equal(result.text, "out of time; here is what I did");
  assert.equal(WALL_CLOCK_RESERVE_MIN_MS, 15_000);
  const toolTurns = result.steps.filter((s) => s.kind === "tool-calls").length;
  assert.ok(toolTurns >= 4 && toolTurns <= 6, `stopped after ${toolTurns} turns`);
  assert.ok(result.elapsedMs <= 20_000);
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
