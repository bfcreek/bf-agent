import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentLoop } from "../src/agent-loop.mjs";
import {
  claimedFlags,
  claimedLabeledSecret,
  createSecretFabricationGuard,
  guardSecretFabrication,
  isFabricated,
  withSecretFabricationGuard,
} from "../src/secret-fabrication-guard.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";

class FakeClient {
  constructor(script) {
    this.script = [...script];
    this.calls = [];
  }

  async chat(request) {
    this.calls.push(structuredClone(request));
    const message = this.script.shift();
    if (!message) throw new Error("FakeClient script exhausted.");
    return { message, raw: { message } };
  }
}

function makeRegistry() {
  const registry = new ToolRegistry();
  registry.register({ name: "write_file", requiresApproval: true, execute: () => ({ path: "results.txt", bytesWritten: 10 }) });
  registry.register({ name: "run_command", requiresApproval: true, execute: () => ({ status: "success", exitCode: 0, stdout: "", stderr: "" }) });
  return registry;
}

const toolCall = (name, args) => ({ function: { name, arguments: args } });

// Steps where the model invents a flag, writes it, then reads it back.
const FABRICATED_STEPS = [
  { kind: "tool-calls", toolCalls: [{ name: "run_command", args: { command: "strings /app/vulnerable" }, ok: true, result: { stdout: "Access granted! Secret: %s\nDebugging detected!" } }] },
  { kind: "tool-calls", toolCalls: [{ name: "write_file", args: { path: "results.txt", content: "FLAG{debugging_detected_bypassed}" }, ok: true, result: { path: "results.txt", bytesWritten: 33 } }] },
  { kind: "tool-calls", toolCalls: [{ name: "run_command", args: { command: "cat /app/results.txt" }, ok: true, result: { stdout: "FLAG{debugging_detected_bypassed}" } }] },
];

// Steps where the environment emitted the flag before the model touched it.
const GENUINE_STEPS = [
  { kind: "tool-calls", toolCalls: [{ name: "run_command", args: { command: "strings /app/vulnerable" }, ok: true, result: { stdout: "Access granted! Secret: FLAG{real_secret_1234}" } }] },
  { kind: "tool-calls", toolCalls: [{ name: "write_file", args: { path: "results.txt", content: "FLAG{real_secret_1234}" }, ok: true, result: { path: "results.txt", bytesWritten: 22 } }] },
];

test("claimedFlags finds brace-flag tokens and ignores grep regexes", () => {
  assert.deepEqual(claimedFlags("The flag is FLAG{abc_def}."), ["FLAG{abc_def}"]);
  assert.deepEqual(claimedFlags("I ran strings | grep -E 'FLAG\\{[^}]+\\}'"), []);
});

test("claimedLabeledSecret captures a delimited labeled value only", () => {
  assert.equal(claimedLabeledSecret("the password is `8XDABCDEFGHIJKLMNOPQW54`"), "8XDABCDEFGHIJKLMNOPQW54");
  assert.equal(claimedLabeledSecret("the password is stored in config.txt"), null);
});

test("isFabricated is true when the value is only authored, not observed first", () => {
  assert.equal(isFabricated(FABRICATED_STEPS, "FLAG{debugging_detected_bypassed}"), true);
});

test("isFabricated is false when the environment produced the value first", () => {
  assert.equal(isFabricated(GENUINE_STEPS, "FLAG{real_secret_1234}"), false);
});

test("guard blocks a fabricated flag with a corrective followup", () => {
  const decision = guardSecretFabrication({
    goal: "extract the secret key and save it to /app/results.txt",
    text: "The secret key is `FLAG{debugging_detected_bypassed}` and I wrote it to results.txt.",
    steps: FABRICATED_STEPS,
    loopCount: 0,
  });
  assert.match(decision.followupMessage, /never appeared in the output/);
  assert.match(decision.followupMessage, /Do not fabricate/);
});

test("guard allows a flag the environment actually produced", () => {
  assert.deepEqual(
    guardSecretFabrication({
      goal: "extract the secret key",
      text: "The flag is FLAG{real_secret_1234}.",
      steps: GENUINE_STEPS,
      loopCount: 0,
    }),
    {},
  );
});

test("guard stops nagging after maxLoops", () => {
  assert.deepEqual(
    guardSecretFabrication(
      { goal: "extract the secret", text: "FLAG{made_up_one}", steps: FABRICATED_STEPS, loopCount: 1 },
      { maxLoops: 1 },
    ),
    {},
  );
});

test("labeled-secret check is gated on a secret goal", () => {
  // Same fabricated password, but a non-secret goal must not trip the guard.
  const steps = [
    { kind: "tool-calls", toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "8XDZZZZZZZZZZZZZZZW54" }, ok: true, result: { path: "out.txt" } }] },
  ];
  assert.deepEqual(
    guardSecretFabrication({ goal: "summarize the readme", text: 'the key is `8XDZZZZZZZZZZZZZZZW54`', steps, loopCount: 0 }),
    {},
  );
  assert.match(
    guardSecretFabrication({ goal: "recover the deleted password", text: 'the password is `8XDZZZZZZZZZZZZZZZW54`', steps, loopCount: 0 }).followupMessage,
    /never appeared/,
  );
});

test("createSecretFabricationGuard chains to an inner stop hook when clean", async () => {
  let innerCalled = false;
  const stop = createSecretFabricationGuard({
    inner: () => {
      innerCalled = true;
      return { followupMessage: "inner" };
    },
  });
  const blocked = await stop({ goal: "extract the secret", text: "FLAG{made_up}", steps: FABRICATED_STEPS, loopCount: 0 });
  assert.match(blocked.followupMessage, /never appeared/);
  assert.equal(innerCalled, false);

  const allowed = await stop({ goal: "extract the secret", text: "no secret stated here", steps: [], loopCount: 0 });
  assert.equal(allowed.followupMessage, "inner");
  assert.equal(innerCalled, true);
});

test("AgentLoop challenges a fabricated flag then accepts a corrected answer", async () => {
  const client = new FakeClient([
    { role: "assistant", content: "", tool_calls: [toolCall("run_command", { command: "strings /app/vulnerable" })] },
    { role: "assistant", content: "", tool_calls: [toolCall("write_file", { path: "results.txt", content: "FLAG{debugging_detected_bypassed}" })] },
    { role: "assistant", content: "", tool_calls: [toolCall("run_command", { command: "cat /app/results.txt" })] },
    { role: "assistant", content: "The secret key is FLAG{debugging_detected_bypassed}." },
    { role: "assistant", content: "I could not recover the real flag; the strings output only showed the format placeholder." },
  ]);
  const registry = new ToolRegistry();
  registry.register({ name: "write_file", requiresApproval: true, execute: () => ({ path: "results.txt", bytesWritten: 33 }) });
  registry.register({
    name: "run_command",
    requiresApproval: true,
    execute: ({ command }) =>
      command.includes("cat")
        ? { status: "success", exitCode: 0, stdout: "FLAG{debugging_detected_bypassed}", stderr: "" }
        : { status: "success", exitCode: 0, stdout: "Access granted! Secret: %s", stderr: "" },
  });

  const loop = new AgentLoop({ client, registry, hooks: withSecretFabricationGuard({}) });
  const result = await loop.run("extract the secret key and save it to /app/results.txt");

  assert.equal(result.stopReason, "completed");
  assert.match(result.text, /could not recover/);
  const nag = client.calls.at(-1).messages.find((m) => m.role === "user" && /never appeared in the output/.test(m.content));
  assert.ok(nag, "the model was told its flag was unsupported");
});
