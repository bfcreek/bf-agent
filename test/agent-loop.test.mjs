import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { AgentLoop, isToolCallParseError } from "../src/agent-loop.mjs";
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

test("wrap-up failure still returns the max-steps result with empty text", async () => {
  const endless = { role: "assistant", content: "", tool_calls: [toolCall("add", { a: 1, b: 1 })] };
  // Script exhausts after the loop steps, so the wrap-up call throws.
  const client = new FakeClient([endless, endless]);
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false, maxSteps: 2 });

  const result = await loop.run("loop forever");

  assert.equal(result.stopReason, "max-steps");
  assert.equal(result.text, "");
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
  assert.equal(result.steps[2].toolCalls[0].result.verificationComplete, true);
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
  assert.equal(result.steps[0].toolCalls[0].result, 3);
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
  const loop = new AgentLoop({ client, registry: makeRegistry() });

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
  const loop = new AgentLoop({ client, registry: makeRegistry() });

  const result = await loop.run("implement a new feature and then run the tests to verify");

  assert.equal(result.steps[0].kind, "plan");
  assert.match(result.steps[0].content, /grep_search/);
  assert.equal(client.calls[0].tools, undefined);
  assert.equal(client.calls[1].tools.length, 2);
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
  assert.match(user.content, /## Task focus/);
  assert.match(user.content, /Mandatory first step/);
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
  const loop = new AgentLoop({ client, registry: makeRegistry(), planning: false });

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
  const loop = new AgentLoop({ client, registry, planning: false });

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
