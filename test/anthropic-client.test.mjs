import assert from "node:assert/strict";
import { test } from "node:test";

import { AnthropicClient } from "../src/providers/anthropic-client.mjs";

test("AnthropicClient maps tools and returns loop dialect", async () => {
  let seen;
  const client = new AnthropicClient({
    sdk: {
      messages: {
        create: async (body) => {
          seen = body;
          return {
            content: [
              { type: "text", text: "calling" },
              { type: "tool_use", id: "toolu_1", name: "echo", input: { text: "hi" } },
            ],
            usage: { input_tokens: 8, output_tokens: 4 },
          };
        },
      },
    },
    model: "claude-sonnet-4-5",
  });

  const { message, raw } = await client.chat({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    tools: [{ type: "function", function: { name: "echo", description: "echo", parameters: { type: "object" } } }],
  });

  assert.equal(seen.system, "sys");
  assert.equal(seen.tools[0].name, "echo");
  assert.equal(message.content, "calling");
  assert.equal(message.tool_calls[0].function.name, "echo");
  assert.deepEqual(message.tool_calls[0].function.arguments, { text: "hi" });
  assert.equal(raw.prompt_eval_count, 8);
});

test("AnthropicClient rejects model auto", async () => {
  const client = new AnthropicClient({
    sdk: { messages: { create: async () => ({}) } },
    model: "auto",
  });
  await assert.rejects(() => client.chat({ messages: [] }), /explicit --model/);
});
