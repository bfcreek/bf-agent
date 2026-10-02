import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fromAnthropicResponse,
  fromOpenAIMessage,
  toAnthropicMessages,
  toOpenAIMessages,
} from "../src/providers/message-bridge.mjs";

test("toOpenAIMessages maps tool_name results to tool_call_id", () => {
  const { messages } = toOpenAIMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "echo", arguments: { text: "hi" } } }],
    },
    { role: "tool", tool_name: "echo", content: "hi" },
  ]);
  assert.equal(messages[2].tool_calls[0].function.name, "echo");
  assert.equal(typeof messages[2].tool_calls[0].id, "string");
  assert.equal(messages[3].role, "tool");
  assert.equal(messages[3].tool_call_id, messages[2].tool_calls[0].id);
  assert.equal(messages[3].content, "hi");
});

test("fromOpenAIMessage parses JSON argument strings", () => {
  const message = fromOpenAIMessage({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        function: { name: "add", arguments: '{"a":1,"b":2}' },
      },
    ],
  });
  assert.equal(message.tool_calls[0].function.name, "add");
  assert.deepEqual(message.tool_calls[0].function.arguments, { a: 1, b: 2 });
});

test("toAnthropicMessages puts tool_result on user turns", () => {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "be helpful" },
    { role: "user", content: "add" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "add", arguments: { a: 1, b: 2 } } }],
    },
    { role: "tool", tool_name: "add", content: "3" },
  ]);
  assert.equal(system, "be helpful");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content[0].type, "tool_use");
  assert.equal(messages[2].role, "user");
  assert.equal(messages[2].content[0].type, "tool_result");
  assert.equal(messages[2].content[0].content, "3");
});

test("fromAnthropicResponse extracts tool_use blocks", () => {
  const message = fromAnthropicResponse({
    content: [
      { type: "text", text: "working" },
      { type: "tool_use", id: "toolu_1", name: "echo", input: { text: "x" } },
    ],
  });
  assert.equal(message.content, "working");
  assert.equal(message.tool_calls[0].function.name, "echo");
  assert.deepEqual(message.tool_calls[0].function.arguments, { text: "x" });
});
