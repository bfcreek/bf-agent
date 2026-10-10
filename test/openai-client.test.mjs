import assert from "node:assert/strict";
import { test } from "node:test";

import { OpenAIClient } from "../src/providers/openai-client.mjs";

function fakeSdk(handler) {
  return {
    chat: {
      completions: {
        create: handler,
      },
    },
    models: {
      list: async () => ({ data: [{ id: "gpt-5" }] }),
    },
  };
}

test("OpenAIClient maps loop tool transcript and returns loop dialect", async () => {
  let seen;
  const client = new OpenAIClient({
    sdk: fakeSdk(async (body) => {
      seen = body;
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "echo", arguments: '{"text":"hi"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    }),
    model: "gpt-5",
  });

  const { message, raw } = await client.chat({
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "echo", arguments: { text: "hi" } } }],
      },
      { role: "tool", tool_name: "echo", content: "hi" },
    ],
    tools: [{ type: "function", function: { name: "echo", parameters: {} } }],
  });

  assert.equal(seen.model, "gpt-5");
  assert.equal(seen.messages.at(-1).role, "tool");
  assert.ok(seen.messages.at(-1).tool_call_id);
  assert.equal(message.tool_calls[0].function.name, "echo");
  assert.deepEqual(message.tool_calls[0].function.arguments, { text: "hi" });
  assert.equal(raw.prompt_eval_count, 10);
  assert.equal(raw.eval_count, 5);
});

test("OpenAIClient maps finish_reason length onto done_reason", async () => {
  const client = new OpenAIClient({
    sdk: fakeSdk(async () => ({
      choices: [{ finish_reason: "length", message: { role: "assistant", content: "partial" } }],
      usage: { prompt_tokens: 2, completion_tokens: 8 },
    })),
    model: "gpt-5",
  });
  const { raw } = await client.chat({ messages: [{ role: "user", content: "go" }] });
  assert.equal(raw.done_reason, "length");
  assert.equal(raw.eval_count, 8);
});

test("OpenAIClient stream maps finish_reason length onto done_reason", async () => {
  async function* chunks() {
    yield { choices: [{ delta: { content: "ops:<tool_call>" }, finish_reason: null }] };
    yield { choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 3, completion_tokens: 12 } };
  }
  const client = new OpenAIClient({
    sdk: fakeSdk(async () => chunks()),
    model: "gpt-5",
  });
  const { message, raw } = await client.chatStream({ messages: [{ role: "user", content: "go" }] });
  assert.match(message.content, /<tool_call>/);
  assert.equal(raw.done_reason, "length");
  assert.equal(raw.eval_count, 12);
});

test("OpenAIClient rejects model auto", async () => {
  const client = new OpenAIClient({
    sdk: fakeSdk(async () => ({})),
    model: "auto",
  });
  await assert.rejects(() => client.chat({ messages: [] }), /explicit --model/);
});
