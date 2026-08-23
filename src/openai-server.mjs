/**
 * OpenAI-compatible facade over the agent loop: POST /v1/chat/completions in,
 * agent loop (with tools) underneath, chat.completion out. This is the door
 * Aura Wire routes IDE traffic through — clients need no halo-agent awareness.
 *
 * The loop itself is non-streaming; `stream: true` is honored by replaying
 * the finished answer as SSE chunks so streaming-only clients still work.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";

import { AgentLoop } from "./agent-loop.mjs";
import { assertToolCapable, isLikelyToolCapable } from "./model-routing.mjs";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * @param {object} options
 * @param {{chat: Function, listModels?: Function}} options.client
 * @param {import("./tool-registry.mjs").ToolRegistry} options.registry
 * @param {string} options.systemPrompt Used when the request has no system message.
 * @param {number} [options.maxSteps]
 * @param {string} [options.defaultModel] Reported in responses when the request omits `model`.
 * @param {object|false} [options.projectBootstrap] First-turn README/RAG bootstrap.
 * @param {object|false} [options.terranRag] Terran corpus RAG on every user message.
 * @returns {http.Server}
 */
export function createOpenAIServer({
  client,
  registry,
  systemPrompt,
  maxSteps = 10,
  defaultModel = "unknown",
  projectBootstrap = false,
  terranRag = false,
}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return await handleModels({ client, defaultModel }, res);
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        return await handleChatCompletions(
          { client, registry, systemPrompt, maxSteps, defaultModel, projectBootstrap, terranRag },
          req,
          res,
        );
      }
      sendError(res, 404, `Unknown route: ${req.method} ${url.pathname}`, "invalid_request_error");
    } catch (err) {
      if (!res.headersSent) {
        sendError(res, 500, err?.message ?? "Internal error", "server_error");
      } else {
        res.end();
      }
    }
  });
}

async function handleModels({ client, defaultModel }, res) {
  let names = [defaultModel];
  if (typeof client.listModels === "function") {
    try {
      const listed = await client.listModels();
      if (listed.length > 0) {
        names = listed.filter((name) => isLikelyToolCapable(name) === true);
      }
    } catch {
      // Ollama unreachable — still report the configured default.
    }
  }
  if (names.length === 0 && isLikelyToolCapable(defaultModel) === true) {
    names = [defaultModel];
  }
  sendJson(res, 200, {
    object: "list",
    data: names.map((id) => ({ id, object: "model", created: 0, owned_by: "ollama" })),
  });
}

async function handleChatCompletions(options, req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return sendError(res, 400, `Invalid request body: ${err.message}`, "invalid_request_error");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendError(res, 400, "'messages' must be a non-empty array.", "invalid_request_error");
  }

  let goal, history;
  try {
    ({ goal, history } = splitMessages(body.messages, options.systemPrompt));
  } catch (err) {
    return sendError(res, 400, err.message, "invalid_request_error");
  }

  const model = typeof body.model === "string" && body.model ? body.model : undefined;
  if (model) {
    try {
      assertToolCapable(model);
    } catch (err) {
      return sendError(res, 400, err.message, "invalid_request_error");
    }
  }
  const runClient = model
    ? { chat: (request) => options.client.chat({ ...request, model }) }
    : options.client;

  const loop = new AgentLoop({
    client: runClient,
    registry: options.registry,
    systemPrompt: options.systemPrompt,
    maxSteps: options.maxSteps,
    compaction: {},
    projectBootstrap: options.projectBootstrap,
    terranRag: options.terranRag,
  });
  const result = await loop.run(goal, { history });

  const reportedModel = model ?? options.defaultModel;
  const finishReason = result.stopReason === "completed" ? "stop" : "length";

  if (body.stream === true) {
    return streamCompletion(res, { text: result.text, model: reportedModel, finishReason });
  }

  sendJson(res, 200, {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: reportedModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.text },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

/**
 * Map an OpenAI messages array onto the loop's (goal, history) contract:
 * the last user message is the goal, everything before it is history, and a
 * system message is injected when the client did not send one.
 */
function splitMessages(messages, fallbackSystemPrompt) {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) {
    throw new Error("'messages' must contain at least one user message.");
  }

  const goal = contentText(messages[lastUserIndex].content);
  const before = messages
    .slice(0, lastUserIndex)
    .map((m) => ({ role: m.role, content: contentText(m.content) }));
  const history = before.some((m) => m.role === "system")
    ? before
    : [{ role: "system", content: fallbackSystemPrompt }, ...before];
  return { goal, history };
}

/** OpenAI content can be a string or an array of typed parts; keep the text. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function streamCompletion(res, { text, model, finishReason }) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  res.write(chunk({ role: "assistant" }));
  if (text) res.write(chunk({ content: text }));
  res.write(chunk({}, finishReason));
  res.write("data: [DONE]\n\n");
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (part) => {
      size += part.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      parts.push(part);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function sendError(res, status, message, type) {
  sendJson(res, status, { error: { message, type } });
}
