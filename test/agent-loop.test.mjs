import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { AgentLoop, DEFAULT_SYSTEM_PROMPT, isToolCallParseError } from "../src/agent-loop.mjs";
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

test("system prompt covers build pipelines, artifacts, and tool-call discipline", () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /Goals:/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /acceptance criteria/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /do not include them in your final answer/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Environment probes \(apt-get/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Exit 0 alone does not mean/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Keep reasoning in thinking/i);
  assert.match(DEFAULT_SYSTEM_PROMPT, /not app\/filter\.py/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Only use[\s\S]*search_project if that tool is listed/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Internal thinking\/reasoning never counts as task progress/i);
});

test("plain answer with no tool calls completes in one step", async () => {
  const client = new FakeClient([{ role: "assistant", content: "hi there" }]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  const result = await loop.run("say hi");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "hi there");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].kind, "final");
  // system + user + assistant
  assert.deepEqual(
    result.messages.map((m) => m.role),
    ["system", "user", "assistant"],
  );
});

test("tool call round-trip: executes tool, feeds result back, returns final", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 2, b: 3 })] },
    { role: "assistant", content: "The sum is 5." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  const result = await loop.run("what is 2+3?");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "The sum is 5.");
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].kind, "tool-calls");
  assert.deepEqual(result.steps[0].toolCalls[0], {
    name: "add",
    args: { a: 2, b: 3 },
    ok: true,
    result: 5,
  });

  // Second model call must include the tool result message.
  const secondCallMessages = client.calls[1].messages;
  const toolMsg = secondCallMessages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "tool result message was sent back to the model");
  assert.equal(toolMsg.tool_name, "add");
  assert.equal(toolMsg.content, "5");

  // Tool schemas are passed on every round-trip.
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
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  const result = await loop.run("do both");

  assert.equal(result.steps[0].toolCalls.length, 2);
  assert.equal(result.steps[0].toolCalls[0].result, 2);
  assert.equal(result.steps[0].toolCalls[1].result, 4);
  const toolMessages = client.calls[1].messages.filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 2);
});

test("tool failure is surfaced to the model, loop continues", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("explode", {})] },
    { role: "assistant", content: "That tool failed." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  const result = await loop.run("try it");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.steps[0].toolCalls[0].ok, false);
  assert.match(result.steps[0].toolCalls[0].error, /boom/);
  const toolMsg = client.calls[1].messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /^ERROR: /);
});

test("unknown tool name is reported back to the model, loop continues", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("no_such_tool", {})] },
    { role: "assistant", content: "Sorry, wrong tool." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  const result = await loop.run("go");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.steps[0].toolCalls[0].ok, false);
  assert.match(result.steps[0].toolCalls[0].error, /Unknown tool 'no_such_tool'/);
});

test("stops at maxSteps and asks for a plain-text wrap-up answer", async () => {
  const endless = { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] };
  const client = new FakeClient([
    endless,
    endless,
    endless,
    { role: "assistant", content: "Partial answer: I added things." }, // wrap-up
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false, maxSteps: 3 });

  const result = await loop.run("loop forever");

  assert.equal(result.stopReason, "max-steps");
  assert.equal(result.text, "Partial answer: I added things.");
  // 3 tool steps + 1 final wrap-up step.
  assert.equal(result.steps.length, 4);
  assert.equal(result.steps[3].kind, "final");
  // The wrap-up call offers no tools and carries the wrap-up instruction.
  const wrapUpCall = client.calls[3];
  assert.equal(wrapUpCall.tools, undefined);
  assert.match(wrapUpCall.messages[wrapUpCall.messages.length - 1].content, /all available tool steps/);
  assert.match(client.calls[2].messages.at(-1).content, /last tool step|diagnosed/i);
});

test("wrap-up failure still returns max-steps with a synthesized summary", async () => {
  const endless = { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] };
  // Script exhausts after the loop steps, so the wrap-up call throws.
  const client = new FakeClient([endless, endless]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false, maxSteps: 2 });

  const result = await loop.run("loop forever");

  assert.equal(result.stopReason, "max-steps");
  assert.match(result.text, /empty final answer|No files were created/i);
  assert.equal(result.steps.length, 2);
});

test("the third consecutive identical tool call is refused with a nudge", async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "probe",
    execute: () => {
      executions++;
      return "same result";
    },
  });
  const same = { role: "assistant", content: "", tool_calls: [toolCall("probe", { q: 1 })] };
  const client = new FakeClient([
    same,
    same,
    same, // refused — nudge goes back instead of a third execution
    { role: "assistant", content: "fine, moving on" },
  ]);
  const loop = new AgentLoop({ client, registry, planning: false });

  const result = await loop.run("go");

  assert.equal(result.text, "fine, moving on");
  assert.equal(executions, 2, "third identical call must not execute");
  const refused = result.steps[2].toolCalls[0];
  assert.equal(refused.ok, false);
  assert.match(refused.error, /times in a row/);
  // A different call resets the streak — nudge text reaches the model.
  const nudgeMsg = client.calls[3].messages.filter((m) => m.role === "tool").pop();
  assert.match(nudgeMsg.content, /^ERROR: /);
});

test("after a passing verification command the loop nudges the model to stop", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "run_command",
    execute: () => ({ status: "success", exitCode: 0, stdout: "ok\n", stderr: "" }),
  });
  const client = new FakeClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "node test.mjs" })],
    },
    { role: "assistant", content: "tests passed" },
  ]);
  const loop = new AgentLoop({ client, registry, planning: false });

  const result = await loop.run(
    "Create greet.mjs and a test.mjs. Run node test.mjs until it passes.",
  );

  assert.equal(result.text, "tests passed");
  assert.equal(result.stopReason, "completed");
  const secondCall = client.calls[1];
  const stopNudge = [...secondCall.messages].reverse().find((m) => m.role === "user");
  assert.match(stopNudge.content, /Verification already succeeded/);
});

test("after a passing test run, extra verify and diagnostic commands are not executed", async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "run_command",
    execute: ({ command }) => {
      executions++;
      return { status: "success", exitCode: 0, stdout: `${command}\n`, stderr: "" };
    },
  });
  const client = new FakeClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "node test.mjs" })],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "node test.mjs" })],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "node -v" })],
    },
    { role: "assistant", content: "done" },
  ]);
  const loop = new AgentLoop({ client, registry, planning: false });

  const result = await loop.run(
    "Create greet.mjs and a test.mjs. Run node test.mjs until it passes.",
  );

  assert.equal(executions, 1);
  assert.equal(result.steps[1].toolCalls[0].ok, true);
  assert.equal(result.steps[1].toolCalls[0].result.verificationComplete, true);
  assert.match(result.steps[1].toolCalls[0].result.note, /Verification already succeeded/);
  assert.equal(result.steps[2].toolCalls[0].ok, true);
  assert.equal(result.steps[2].toolCalls[0].result.status, "blocked");
  assert.equal(result.steps[2].toolCalls[0].result.verificationComplete, undefined);
  assert.match(result.steps[2].toolCalls[0].result.command, /node -v/);
  assert.equal(result.text, "done");
});

test("after tests pass, a different named CLI command still runs", async () => {
  const ran = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "run_command",
    execute: ({ command }) => {
      ran.push(command);
      return { status: "success", exitCode: 0, stdout: "ok\n", stderr: "" };
    },
  });
  const client = new FakeClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "node test.mjs" })],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "node summarize.mjs data.csv" })],
    },
    { role: "assistant", content: "verified" },
  ]);
  const loop = new AgentLoop({ client, registry, planning: false });
  const result = await loop.run(
    "Create summarize.mjs. Run node test.mjs, then node summarize.mjs data.csv.",
  );
  assert.deepEqual(ran, ["node test.mjs", "node summarize.mjs data.csv"]);
  assert.equal(result.text, "verified");
});


test("transient client errors are retried once", async () => {
  const flaky = {
    attempts: 0,
    async chat() {
      this.attempts++;
      if (this.attempts === 1) {
        const err = new Error("Cannot reach Ollama");
        err.name = "OllamaClientError";
        err.status = null;
        throw err;
      }
      return { message: { role: "assistant", content: "recovered" }, raw: {} };
    },
  };
  const loop = new AgentLoop({ client: flaky, registry: makeRegistry(), planning: false });

  const result = await loop.run("go");

  assert.equal(result.text, "recovered");
  assert.equal(flaky.attempts, 2);
});

test("client errors with a 4xx status are not retried", async () => {
  const failing = {
    attempts: 0,
    async chat() {
      this.attempts++;
      const err = new Error("model not found");
      err.name = "OllamaClientError";
      err.status = 404;
      throw err;
    },
  };
  const loop = new AgentLoop({ client: failing, registry: makeRegistry(), planning: false });

  await assert.rejects(() => loop.run("go"), /model not found/);
  assert.equal(failing.attempts, 1);
});

test("tool-call parse 500s are nudged and recovered", async () => {
  let phase = 0;
  const client = {
    async chat({ messages }) {
      phase++;
      if (phase === 1) {
        const err = new Error(
          `Ollama /api/chat returned 500: {"error":"error parsing tool call: raw='thinking...{\\"pattern\\":\\"x\\"}"}`,
        );
        err.name = "OllamaClientError";
        err.status = 500;
        throw err;
      }
      if (phase === 2) {
        const nudged = messages.some(
          (m) => m.role === "user" && /tool-call channel/i.test(m.content ?? ""),
        );
        assert.ok(nudged, "expected a parse-recovery nudge in messages");
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [toolCall("add", { a: 1, b: 2 })],
          },
          raw: {},
        };
      }
      return { message: { role: "assistant", content: "3" }, raw: {} };
    },
  };

  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });
  const result = await loop.run("add 1 and 2");

  assert.equal(result.text, "3");
  const parseStep = result.steps.find((s) => s.kind === "tool-parse-error");
  assert.ok(parseStep, "expected a logged tool-parse-error step");
  assert.match(parseStep.content, /error parsing tool call/i);
  const toolStep = result.steps.find((s) => s.kind === "tool-calls");
  assert.equal(toolStep.toolCalls[0].result, 3);
  assert.equal(phase, 3);
});

test("tool-call parse errors exhaust recoveries then throw", async () => {
  const failing = {
    attempts: 0,
    async chat() {
      this.attempts++;
      const err = new Error(
        'Ollama /api/chat returned 500: {"error":"error parsing tool call: raw=\'x\'"}',
      );
      err.name = "OllamaClientError";
      err.status = 500;
      throw err;
    },
  };
  const loop = new AgentLoop({ client: failing, registry: makeRegistry(), planning: false });

  await assert.rejects(() => loop.run("go"), /error parsing tool call/);
  // Initial attempt + 2 recoveries = 3
  assert.equal(failing.attempts, 3);
});

test("isToolCallParseError detects Ollama parse failures", () => {
  const err = new Error(
    'Ollama /api/chat returned 500: {"error":"error parsing tool call: raw=\'x\'"}',
  );
  err.name = "OllamaClientError";
  err.status = 500;
  assert.equal(isToolCallParseError(err), true);

  const other = new Error("Ollama /api/chat returned 500: boom");
  other.name = "OllamaClientError";
  other.status = 500;
  assert.equal(isToolCallParseError(other), false);
});

test("string tool arguments (JSON) are parsed before execution", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", '{"a":4,"b":6}')] },
    { role: "assistant", content: "10." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  const result = await loop.run("add them");

  assert.equal(result.steps[0].toolCalls[0].ok, true);
  assert.equal(result.steps[0].toolCalls[0].result, 10);
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
  // Caller's history array is not mutated.
  assert.equal(history.length, 3);
});

test("onStep observer fires for every step", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] },
    { role: "assistant", content: "3." },
  ]);
  const seen = [];
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    planning: false,
    onStep: (step) => seen.push(step.kind),
  });

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

let bootstrapRoot;

before(async () => {
  bootstrapRoot = await mkdtemp(path.join(os.tmpdir(), "halo-agent-loop-boot-"));
  await writeFile(path.join(bootstrapRoot, "README.md"), "# Boot Project\n\nUnique boot marker.\n", "utf8");
});

after(async () => {
  await rm(bootstrapRoot, { recursive: true, force: true });
});

test("projectBootstrap injects README on the first turn only", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "boot answer" },
    { role: "assistant", content: "follow-up answer" },
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    planning: false,
    projectBootstrap: { workspaceRoot: bootstrapRoot },
  });

  const first = await loop.run("what is this project?");
  assert.match(first.messages.find((m) => m.role === "user").content, /Unique boot marker/);
  assert.match(client.calls[0].messages.find((m) => m.role === "user").content, /Auto-retrieved project context/);

  const history = first.messages;
  await loop.run("follow up", { history });
  const followUpUsers = client.calls[1].messages.filter((m) => m.role === "user");
  assert.equal(followUpUsers[followUpUsers.length - 1].content, "follow up");
});

test("simple read-and-answer goals skip the planning pre-pass", async () => {
  const client = new FakeClient([{ role: "assistant", content: "ok" }]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("Reply with just ok.");

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].kind, "final");
  assert.ok(client.calls[0].tools?.length > 0, "first call should be the tool loop, not a plan");
  assert.doesNotMatch(client.calls[0].messages.at(-1).content, /Do not call tools yet/);
});

test("short create goals still get a planning pre-pass", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "1. write_file package.json\n2. write_file main.js\n3. run_command npm install" },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] },
    { role: "assistant", content: "Created the Electron shell." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), critique: false });

  const result = await loop.run("create the shell for an electron app");

  assert.equal(result.steps[0].kind, "plan");
  assert.match(result.steps[0].content, /write_file|package.json/i);
  assert.equal(client.calls[0].tools, undefined);
});

test("first-turn goals get a planning pre-pass before tools", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "1. grep_search for foo\n2. read_file src/foo.mjs\n3. edit" },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] },
    { role: "assistant", content: "The feature outline is ready for review." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), critique: false });

  const result = await loop.run("implement a new feature and then run the tests to verify");

  assert.equal(result.steps[0].kind, "plan");
  assert.match(result.steps[0].content, /grep_search/);
  assert.equal(client.calls[0].tools, undefined);
  assert.equal(client.calls[1].tools.length, 2);
});

test("the critique pass revises the plan before tools are offered", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "1. grep_search for foo\n2. edit" },
    { role: "assistant", content: "Risk: editing before reading.\n1. read_file src/foo.mjs\n2. edit" },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] },
    { role: "assistant", content: "The feature outline is ready for review." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("implement a new feature and then run the tests to verify");

  const planSteps = result.steps.filter((s) => s.kind === "plan");
  assert.equal(planSteps.length, 2);
  assert.match(planSteps[1].content, /Risk: editing before reading/);
  assert.equal(client.calls[0].tools, undefined);
  assert.equal(client.calls[1].tools, undefined);
  assert.match(client.calls[1].messages.at(-1).content, /failure modes/i);
  assert.equal(client.calls[2].tools.length, 2);
});

test("an acceptance command from the plan blocks completion until it runs", async () => {
  const ran = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "run_command",
    execute: ({ command }) => {
      ran.push(command);
      return { status: "success", exitCode: 0, stdout: "1 passing\n", stderr: "" };
    },
  });
  const client = new FakeClient([
    { role: "assistant", content: "1. edit the module\n\n## Acceptance\n- command: node test.mjs" },
    { role: "assistant", content: "All set — the feature works." },
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "node test.mjs" })],
    },
    { role: "assistant", content: "Feature implemented; node test.mjs passes." },
  ]);
  const loop = new AgentLoop({ client, registry, critique: false });

  const result = await loop.run("implement a new feature and then run the tests to verify");

  assert.equal(result.stopReason, "completed");
  assert.deepEqual(ran, ["node test.mjs"]);
  assert.equal(result.verification.passed, true);
  assert.ok(
    client.calls.some((c) =>
      c.messages.some(
        (m) =>
          m.role === "user" && /do not finish yet|verification command|node test\.mjs/i.test(m.content),
      ),
    ),
    "the premature final answer should have been blocked",
  );
});

test("an unsatisfiable acceptance contract reports failure instead of looping", async () => {
  const plan = { role: "assistant", content: "1. write it\n\n## Acceptance\n- command: node missing.mjs" };
  const done = { role: "assistant", content: "Done." };
  const client = new FakeClient([plan, done, done, done, done, done, done, done, done]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    critique: false,
    maxSteps: 6,
  });

  const result = await loop.run("implement a new feature and then run the tests to verify");

  assert.equal(result.verification.passed, false);
  assert.ok(result.verification.missing.some((m) => /node missing\.mjs/.test(m)));
  assert.ok(result.steps.length <= 8, "the gate must not spin past the step budget");
});

test("the gate keeps pushing rather than accepting an early premature finish", async () => {
  const done = { role: "assistant", content: "All done." };
  const client = new FakeClient([
    { role: "assistant", content: "1. write it\n\n## Acceptance\n- command: node test.mjs" },
    ...Array.from({ length: 16 }, () => done),
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    critique: false,
    maxSteps: 12,
  });

  const result = await loop.run("implement a new feature and then run the tests to verify");

  const blocks = client.calls.filter((c) =>
    c.messages.some((m) => m.role === "user" && /acceptance contract not satisfied/i.test(m.content)),
  ).length;
  assert.ok(blocks >= 3, `expected the gate to block repeatedly, saw ${blocks}`);
  assert.equal(result.verification.passed, false);
  assert.equal(result.stopReason, "failed", "a hollow finish must not be marked completed");
});

test("mid-run acceptance nudge fires under budget pressure before a hollow finish", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "run_command",
    execute: () => ({ status: "success", exitCode: 0, stdout: "probe\n", stderr: "" }),
  });
  const probe = {
    role: "assistant",
    content: "",
    tool_calls: [toolCall("run_command", { command: "echo probe" })],
  };
  const done = { role: "assistant", content: "Done without the file." };
  const client = new FakeClient([
    { role: "assistant", content: "1. explore\n\n## Acceptance\n- deliverable: out.txt" },
    ...Array.from({ length: 8 }, () => probe),
    ...Array.from({ length: 12 }, () => done),
  ]);
  const loop = new AgentLoop({
    client,
    registry,
    critique: false,
    maxSteps: 10,
  });

  const result = await loop.run("Create out.txt with the final answer for this task.");

  assert.equal(result.verification?.passed, false);
  const midRun = client.calls.some((c) =>
    c.messages.some(
      (m) =>
        m.role === "user" &&
        /named deliverable|Still required: create out\.txt|write_file.*out\.txt/i.test(m.content),
    ),
  );
  assert.ok(midRun, "unmet deliverables under budget pressure must nudge before a hollow finish");
});

test("an always-true acceptance contract is failed not completed", async () => {
  const done = { role: "assistant", content: "Done." };
  const client = new FakeClient([
    { role: "assistant", content: "1. start it\n\n## Acceptance\n- command: echo ok" },
    ...Array.from({ length: 16 }, () => done),
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    critique: false,
    maxSteps: 6,
  });

  const result = await loop.run("implement a new feature and then run the tests to verify");

  assert.equal(result.verification.passed, false);
  assert.ok(result.verification.missing.some((m) => /always-true|empty acceptance|no deliverable work/i.test(m)));
  assert.equal(result.stopReason, "failed", "a vacuous contract must not count as done");
});

test("a harbor-style compile goal cannot finish with plan-only turns", async () => {
  const done = { role: "assistant", content: "Compiled successfully." };
  const client = new FakeClient([
    {
      role: "assistant",
      content: [
        "## Plan",
        "1. extract and compile",
        "## Acceptance",
        "- **Deliverable**: `/app/vendor/src.tar.gz` must exist.",
        "- **Command**: `test -f /app/vendor/src.tar.gz` must exit 0.",
      ].join("\n"),
    },
    ...Array.from({ length: 16 }, () => done),
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    critique: false,
    maxSteps: 8,
  });

  const result = await loop.run(
    "Compile the tool in /app/out using the pre-vendored snapshot at /app/vendor/src.tar.gz.",
  );

  assert.equal(result.verification.passed, false);
  assert.ok(result.verification.missing.some((m) => /no deliverable work|always-true/i.test(m)));
  assert.notEqual(result.stopReason, "completed");
});

test("task hints are injected into the user message", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "Inspecting the failure next." },
    { role: "assistant", content: "Inspecting the failure next." },
    { role: "assistant", content: "Inspecting the failure next." },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  await loop.run("fix the failing test in auth.spec.mjs");

  const user = client.calls[0].messages.find((m) => m.role === "user");
  assert.match(user.content, /## Goals/);
  assert.match(user.content, /## Task focus/);
  assert.match(user.content, /Mandatory first step/);
});

test("explicit goals are injected for artifact-creation tasks", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "done" },
    { role: "assistant", content: "done" },
    { role: "assistant", content: "done" },
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    planning: false,
    taskHints: false,
    acceptance: false,
  });

  await loop.run("Write the output fasta file titled primers.fasta from sequences.fasta.");

  const user = client.calls[0].messages.find((m) => m.role === "user");
  assert.match(user.content, /## Goals \(explicit outcomes\)/);
  assert.match(user.content, /primers\.fasta/);
  assert.doesNotMatch(user.content, /## Task focus/);
});

test("planning and hints can be disabled", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "ok" },
    { role: "assistant", content: "ok" },
    { role: "assistant", content: "ok" },
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    planning: false,
    taskHints: false,
  });

  const result = await loop.run("implement a new feature and then run the tests to verify");

  assert.equal(result.steps.length, 1);
  const user = client.calls[0].messages.find((m) => m.role === "user");
  assert.doesNotMatch(user.content, /## Task focus/);
});

test("premature final without tools is nudged to use tools", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "I created greet.mjs for you." },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] },
    { role: "assistant", content: "Done — files created and test passed." },
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("add", { a: 0, b: 0 })],
    },
    { role: "assistant", content: "Created greet.mjs; tests already present and passing." },
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    planning: false,
    acceptance: false,
  });

  const result = await loop.run("Create greet.mjs and test.mjs, then run node test.mjs.");

  assert.equal(result.stopReason, "completed");
  assert.match(client.calls[1].messages.at(-1).content, /without calling any tools/);
  // After a non-test tool call plus a success claim, verify nudge should fire.
  assert.ok(
    client.calls.some((c) =>
      c.messages.some(
        (m) => m.role === "user" && /verification command|run_command/i.test(m.content),
      ),
    ),
  );
});

test("test-fix goals block edit_file until a pretest run_command", async () => {
  const registry = makeRegistry();
  registry.register({
    name: "edit_file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
    execute: () => ({ replacements: 1 }),
  });
  let runs = 0;
  registry.register({
    name: "run_command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    execute: () => {
      runs += 1;
      return {
        exitCode: runs === 1 ? 1 : 0,
        stdout: runs === 1 ? "fail" : "ok",
        stderr: "",
      };
    },
  });

  const client = new FakeClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        toolCall("edit_file", { path: "lib/math.mjs", old_string: "a-b", new_string: "a+b" }),
      ],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "node test.mjs" })],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        toolCall("edit_file", { path: "lib/math.mjs", old_string: "a-b", new_string: "a+b" }),
      ],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "node test.mjs" })],
    },
    { role: "assistant", content: "Fixed the bugs; node test.mjs passed." },
  ]);
  const loop = new AgentLoop({ client, registry, planning: false, maxSteps: 8 });

  const result = await loop.run(
    "Run node test.mjs — it fails because of bugs in lib/math.mjs. Fix the bugs so all tests pass.",
  );

  const firstEdit = result.steps[0].toolCalls[0];
  assert.equal(firstEdit.name, "edit_file");
  assert.equal(firstEdit.ok, false);
  assert.match(firstEdit.error, /Blocked/);

  const secondEdit = result.steps[2].toolCalls[0];
  assert.equal(secondEdit.name, "edit_file");
  assert.equal(secondEdit.ok, true);
  assert.equal(result.stopReason, "completed");
  assert.match(result.text, /passed/);
});

test("empty answer on a read question is nudged", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "" },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "8080" },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  const result = await loop.run(
    "Read README.md and answer: what port does the service use? Reply with just the number.",
  );

  assert.equal(result.text, "8080");
  assert.match(client.calls[1].messages.at(-1).content, /empty/i);
});

test("empty answer after search on a path question is nudged", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "grep_search",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
    execute: () => "1 match(es) in 1 file(s):\nlib/tax.py:1: def compute_tax(n):",
  });
  const client = new FakeClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("grep_search", { pattern: "compute_tax" })],
    },
    { role: "assistant", content: "" },
    { role: "assistant", content: "lib/tax.py" },
  ]);
  const loop = new AgentLoop({ client, registry, planning: false });

  const result = await loop.run(
    "Which file defines the function compute_tax? Reply with the path relative to the workspace root only.",
  );

  assert.equal(result.text, "lib/tax.py");
  assert.ok(
    client.calls.some((call) =>
      call.messages.some(
        (m) => m.role === "user" && /empty|DEFINES the symbol|relative path/i.test(m.content),
      ),
    ),
  );
});

test("ambiguous edit_file injects a re-read and per-function plan nudge", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "edit_file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
    execute: () => {
      throw new Error("old_string appears 2 times; include the enclosing function");
    },
  });
  const client = new FakeClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        toolCall("edit_file", {
          path: "calc.py",
          old_string: "return a + b",
          new_string: "return a * b",
        }),
      ],
    },
    { role: "assistant", content: "I'll re-read the file and edit one function at a time." },
    { role: "assistant", content: "Need enclosing function context before editing again." },
    { role: "assistant", content: "Stopped until the snippet is unique." },
  ]);
  const loop = new AgentLoop({ client, registry, planning: false, acceptance: false });

  const result = await loop.run("Inspect calc.py and correct the mul function.");

  assert.equal(result.stopReason, "completed");
  assert.ok(
    client.calls.some((call) =>
      call.messages.some(
        (m) => m.role === "user" && /read_file the current file|unique edit per function/i.test(m.content),
      ),
    ),
  );
});

test("apt-get --version does not block later install/build commands", async () => {
  const ran = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "run_command",
    execute: ({ command }) => {
      ran.push(command);
      return { status: "success", exitCode: 0, stdout: `${command} ok\n`, stderr: "" };
    },
  });
  const client = new FakeClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "apt-get --version" })],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "apt-get install -y ocaml" })],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "wget https://example.com/compcert.tgz" })],
    },
    { role: "assistant", content: "installed deps" },
    { role: "assistant", content: "Build is still in progress; /tmp/CompCert/ccomp is not ready." },
    { role: "assistant", content: "Stopping here; ccomp was not produced." },
  ]);
  const loop = new AgentLoop({ client, registry, planning: false });
  const result = await loop.run(
    "Under /tmp/CompCert/, build CompCert from source. Ensure it can be invoked through /tmp/CompCert/ccomp.",
  );
  assert.deepEqual(ran, [
    "apt-get --version",
    "apt-get install -y ocaml",
    "wget https://example.com/compcert.tgz",
  ]);
  assert.equal(result.steps[0].toolCalls[0].result.verificationComplete, undefined);
  assert.match(result.text, /ccomp|Stopping/i);
  assert.ok(
    client.calls.some((call) =>
      call.messages.some((m) => m.role === "user" && /ccomp|still need/i.test(m.content)),
    ),
  );
});

test("write_file still runs after a passing test verification", async () => {
  const wrote = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "run_command",
    execute: () => ({ status: "success", exitCode: 0, stdout: "ok\n", stderr: "" }),
  });
  registry.register({
    name: "write_file",
    execute: ({ path: p, content }) => {
      wrote.push(p);
      return { path: p, bytes: String(content ?? "").length };
    },
  });
  const client = new FakeClient([
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("run_command", { command: "node test.mjs" })],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [toolCall("write_file", { path: "primers.fasta", content: ">fwd\nATGC\n" })],
    },
    { role: "assistant", content: "wrote primers.fasta" },
  ]);
  const loop = new AgentLoop({ client, registry, planning: false });
  const result = await loop.run(
    "The output fasta file should be titled primers.fasta. Also run node test.mjs.",
  );
  assert.deepEqual(wrote, ["primers.fasta"]);
  assert.equal(result.text, "wrote primers.fasta");
});

test("empty final answers are synthesized instead of completing blank", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "" },
    { role: "assistant", content: "" },
    { role: "assistant", content: "" },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });
  const result = await loop.run("say hello");
  assert.equal(result.stopReason, "completed");
  assert.ok(result.text.trim().length > 0);
  assert.match(result.text, /empty final answer/i);
});

test("consecutive empty responses on artifact tasks fail instead of completing", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", thinking: "planning polyglot layout" },
    { role: "assistant", content: "", thinking: "still planning" },
    { role: "assistant", content: "", thinking: "after acceptance nudge" },
    { role: "assistant", content: "", thinking: "still empty" },
    { role: "assistant", content: "" },
  ]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false, maxSteps: 8 });
  const goal =
    "Create a polyglot at polyglot/main.rs that compiles with rustc and g++.";
  const result = await loop.run(goal);
  assert.equal(result.stopReason, "failed");
  assert.match(result.text, /No files were created|Still required/i);
  const nudges = client.calls.flatMap((c) =>
    c.messages.filter((m) => m.role === "user").map((m) => m.content),
  );
  assert.ok(nudges.some((n) => /mkdir -p polyglot|write_file polyglot\/main\.rs/i.test(n)));
  assert.ok(
    nudges.some((n) => /acceptance|Still required|write_file/i.test(n)),
    "empty stalls with unmet deliverables should get an acceptance write_file nudge before hard fail",
  );
});

test("thinking-only turns do not consume the step budget", async () => {
  let chatCalls = 0;
  const client = {
    async chat() {
      chatCalls += 1;
      if (chatCalls <= 2) {
        return {
          message: { role: "assistant", content: "", thinking: "reasoning only" },
          raw: { eval_count: 0 },
        };
      }
      return { message: { role: "assistant", content: "hi" }, raw: { eval_count: 3 } };
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false, maxSteps: 2 });
  const result = await loop.run("say hello");
  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "hi");
  assert.ok(chatCalls >= 3, "thinking-only turns should not consume the 2-step budget");
});

test("follow-up turns run an adjust-plan pass when replan is enabled", async () => {
  const client = new FakeClient([
    {
      role: "assistant",
      content: "1. write_file a.mjs\n\n## Acceptance\n- deliverable: a.mjs",
    },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "Created a.mjs." },
    {
      role: "assistant",
      content: "1. write_file b.mjs\n2. run_command node b.mjs\n\n## Acceptance\n- deliverable: b.mjs",
    },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 2, b: 2 })] },
    { role: "assistant", content: "Created b.mjs for the follow-up." },
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    critique: false,
    acceptance: false,
    taskHints: false,
  });

  const first = await loop.run("create a.mjs for the feature");
  assert.equal(first.steps[0].kind, "plan");

  const second = await loop.run("now add b.mjs and run it to verify", { history: first.messages });
  assert.equal(second.steps[0].kind, "plan");
  assert.match(second.steps[0].content, /b\.mjs/);
  const adjustCall = client.calls.find(
    (c) =>
      c.tools === undefined &&
      c.messages.some((m) => m.role === "user" && /Adjust the plan/i.test(m.content)),
  );
  assert.ok(adjustCall, "adjust-plan call should have no tools");
});

test("replan:false skips follow-up adjust-plan", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "1. write_file a.mjs" },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "done first" },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 2, b: 2 })] },
    { role: "assistant", content: "done second" },
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    critique: false,
    acceptance: false,
    taskHints: false,
    replan: false,
  });

  const first = await loop.run("create a.mjs for the feature");
  await loop.run("now add b.mjs and run it to verify", { history: first.messages });

  assert.ok(
    !client.calls.some((c) =>
      c.messages.some((m) => m.role === "user" && /Adjust the plan/i.test(m.content)),
    ),
  );
});

test("half-budget injects a plan checkpoint once", async () => {
  const registry = makeRegistry();
  registry.register({
    name: "write_file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    execute: () => ({ status: "success" }),
  });
  const client = new FakeClient([
    {
      role: "assistant",
      content: "1. write_file out.py\n2. summarize\n\n## Acceptance\n- deliverable: out.py",
    },
    { role: "assistant", content: "", tool_calls: [toolCall("write_file", { path: "out.py", content: "x" })] },
    { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] },
    { role: "assistant", content: "All done with out.py." },
    { role: "assistant", content: "All done with out.py." },
  ]);
  const loop = new AgentLoop({
    client,
    registry,
    critique: false,
    acceptance: false,
    taskHints: false,
    maxSteps: 4,
  });

  const result = await loop.run("create out.py then summarize the work for review");
  const checkpoints = result.steps.filter((s) => s.kind === "checkpoint");
  assert.equal(checkpoints.length, 1);
  assert.match(checkpoints[0].content, /## Plan progress/);
  assert.match(checkpoints[0].content, /\[x\] 1\. write_file out\.py/);
});

test("struggle replan is capped and refreshes the plan step", async () => {
  const same = { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 9, b: 9 })] };
  const client = new FakeClient([
    { role: "assistant", content: "1. call add repeatedly\n2. finish" },
    same,
    same,
    same,
    {
      role: "assistant",
      content: "1. stop repeating\n2. answer\n\n## Acceptance\n- output: done",
    },
    { role: "assistant", content: "Stopped repeating; the feature outline is ready for review." },
    { role: "assistant", content: "Stopped repeating; the feature outline is ready for review." },
    { role: "assistant", content: "Stopped repeating; the feature outline is ready for review." },
    { role: "assistant", content: "Stopped repeating; the feature outline is ready for review." },
  ]);
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    critique: false,
    acceptance: false,
    taskHints: false,
    maxSteps: 8,
  });

  const result = await loop.run("outline a new feature for review");
  const plans = result.steps.filter((s) => s.kind === "plan");
  assert.ok(plans.length >= 2, "initial plan plus at least one remaining-step replan");
  assert.match(plans.at(-1).content, /stop repeating|answer/i);
  const replanCalls = client.calls.filter(
    (c) =>
      c.tools === undefined &&
      c.messages.some((m) => m.role === "user" && /remaining work|Progress against the plan/i.test(m.content)),
  );
  assert.ok(replanCalls.length >= 1 && replanCalls.length <= 2);
});

function ollamaError(message, status) {
  const err = new Error(message);
  err.name = "OllamaClientError";
  // 4xx skips chatWithRetry backoff so the test stays fast; the run() catch
  // only requires the error class, matching wrapped transport failures too.
  err.status = status;
  return err;
}

test("mid-run model-call failure without escalation ends as a failed run, not a crash", async () => {
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      if (calls === 1) {
        return {
          message: { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 2 })] },
          raw: {},
        };
      }
      throw ollamaError("Ollama stream failed mid-response: body timeout", 404);
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  const result = await loop.run("say hi");

  assert.equal(result.stopReason, "failed");
  const failStep = result.steps.find((s) => s.kind === "failed");
  assert.ok(failStep, "the failure must be recorded as a step, not thrown");
  assert.match(String(failStep.diagnostic ?? ""), /model call failed/i);
  assert.ok(
    result.steps.some((s) => s.kind === "tool-calls"),
    "completed work must survive in the trajectory",
  );
});

test("startup model-call failure still propagates for exit-code mapping", async () => {
  const client = {
    async chat() {
      throw ollamaError("Ollama /api/chat returned 404: model missing", 404);
    },
  };
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

  await assert.rejects(loop.run("say hi"), /model missing/);
});

test("model-call failure escalates to the next rung and continues the run", async () => {
  const { EscalationController } = await import("../src/escalation.mjs");
  const client = {
    model: "qwen3:8b",
    calls: [],
    async chat({ messages }) {
      this.calls.push(this.model);
      if (this.model === "qwen3:8b") {
        throw ollamaError("Ollama stream failed mid-response: body timeout", 404);
      }
      return { message: { role: "assistant", content: "recovered" }, raw: {} };
    },
    async show() {
      return { capabilities: ["tools"] };
    },
  };
  const escalation = new EscalationController({
    client,
    ladder: [
      { name: "qwen3:8b", paramsB: 8, cloud: false },
      { name: "qwen3:14b", paramsB: 14, cloud: false },
    ],
  });
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    planning: false,
    escalation,
  });

  const result = await loop.run("say hi");

  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "recovered");
  assert.ok(
    result.steps.some(
      (s) => s.kind === "escalation" && /transport failure/i.test(s.content),
    ),
    "the swap must be visible in the step log",
  );
  assert.deepEqual(client.calls, ["qwen3:8b", "qwen3:14b"]);
});

test("model swap re-opens the acceptance contract for the stronger model", async () => {
  const { EscalationController } = await import("../src/escalation.mjs");
  const client = {
    model: "qwen3:8b",
    thinkingCapable: true,
    think: "high",
    seenReopen: false,
    async chat({ messages, tools }) {
      const blob = JSON.stringify(messages);
      if (/Re-open the acceptance contract/i.test(blob)) this.seenReopen = true;
      if (this.model === "qwen3:8b" && tools) {
        // Struggle: empty turns until escalate intensifies (noop when already high)
        // then swaps. Force swap by leaving think high and producing empties.
        return { message: { role: "assistant", content: "" }, raw: { eval_count: 0 } };
      }
      if (this.model === "qwen3:14b") {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [toolCall("add", { a: 1, b: 1 })],
          },
          raw: {},
        };
      }
      return { message: { role: "assistant", content: "2" }, raw: {} };
    },
    async show() {
      return { capabilities: ["tools", "thinking"] };
    },
    async listModelsDetailed() {
      return [
        { name: "qwen3:8b", sizeBytes: 1, parameterSize: "8B" },
        { name: "qwen3:14b", sizeBytes: 1, parameterSize: "14B" },
      ];
    },
  };
  // Start already intensified so the first maybeEscalate must swap models.
  const escalation = new EscalationController({
    client,
    ladder: [
      { name: "qwen3:8b", paramsB: 8, cloud: false, thinking: true },
      { name: "qwen3:14b", paramsB: 14, cloud: false, thinking: true },
    ],
    threshold: 2,
  });
  escalation._intensified = true;
  const loop = new AgentLoop({
    client,
    registry: makeRegistry(),
    planning: false,
    escalation,
    maxSteps: 6,
  });

  await loop.run("implement feature.js and run node test.mjs");

  assert.equal(client.model, "qwen3:14b");
  assert.equal(
    client.seenReopen,
    true,
    "after a model swap the next turn must see the re-opened contract",
  );
});
