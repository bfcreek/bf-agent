/**
 * OpenAI-compatible facade over the agent loop: POST /v1/chat/completions in,
 * agent loop (with tools) underneath, chat.completion out. This is the door
 * Aura Wire routes IDE traffic through — clients need no halo-agent awareness.
 *
 * With `stream: true`, SSE headers go out immediately. Content tokens are the
 * final answer only — the loop withholds tool narration and discarded turns,
 * because this stream is the message the editor shows and it cannot be
 * rewound. If the backend only supports non-streaming chat, the finished
 * answer is replayed as SSE chunks so streaming-only clients still work.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";

import { AgentLoop, DEFAULT_MAX_STEPS } from "./agent-loop.mjs";
import {
  assertToolCapable,
  assertVisionCapable,
  detectCapabilities,
  isLikelyToolCapable,
  messagesHaveImages,
  ModelRoutingError,
  resolveModelAuto,
} from "./model-routing.mjs";
import { resolveTierModel } from "./tier-models.mjs";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * @param {object} options
 * @param {{chat: Function, chatStream?: Function, listModels?: Function, listModelsDetailed?: Function, show?: Function}} options.client
 * @param {import("./tool-registry.mjs").ToolRegistry} options.registry
 * @param {string} options.systemPrompt Used when the request has no system message.
 * @param {number} [options.maxSteps]
 * @param {string} [options.defaultModel] Reported in responses when the request omits `model`.
 * @param {import("./tier-models.mjs").TierModelBand[]|null} [options.tierModels] Tier bands; `vision` used for image turns.
 * @param {number} [options.defaultTier] Difficulty tier when selecting a band's vision model.
 * @param {import("./agent-loop.mjs").AgentHooks} [options.hooks]
 * @returns {http.Server}
 */
export function createOpenAIServer({
  client,
  registry,
  systemPrompt,
  maxSteps = DEFAULT_MAX_STEPS,
  defaultModel = "unknown",
  tierModels = null,
  defaultTier = 2,
  hooks,
}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return await handleModels({ client, defaultModel }, res);
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        return await handleChatCompletions(
          {
            client,
            registry,
            systemPrompt,
            maxSteps,
            defaultModel,
            tierModels,
            defaultTier,
            hooks,
          },
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

  const requireVision = messagesHaveImages(body.messages);

  let goal, history, images;
  try {
    ({ goal, history, images } = splitMessages(body.messages, options.systemPrompt));
  } catch (err) {
    return sendError(res, 400, err.message, "invalid_request_error");
  }

  let model = typeof body.model === "string" && body.model ? body.model : undefined;
  try {
    model = await resolveRequestModel({
      requested: model,
      defaultModel: options.defaultModel,
      client: options.client,
      requireVision,
      tierModels: options.tierModels,
      defaultTier: options.defaultTier,
    });
  } catch (err) {
    if (err instanceof ModelRoutingError) {
      return sendError(res, 400, err.message, "invalid_request_error");
    }
    throw err;
  }

  const runClient = wrapClientForModel(options.client, model);

  const wantStream = body.stream === true;
  const abort = new AbortController();
  const onClientGone = () => abort.abort();
  req.on("close", onClientGone);

  const reportedModel = model ?? options.defaultModel;
  let streamState = null;

  try {
    if (wantStream) {
      streamState = beginCompletionStream(res, reportedModel);
    }

    const loop = new AgentLoop({
      client: runClient,
      registry: options.registry,
      systemPrompt: options.systemPrompt,
      maxSteps: options.maxSteps,
      compaction: {},
      hooks: options.hooks,
      onDelta: streamState
        ? (delta) => {
            streamState.streamed += delta;
            streamState.writeContent(delta);
          }
        : undefined,
    });
    const result = await loop.run(goal, {
      history,
      signal: abort.signal,
      ...(images?.length ? { images } : {}),
    });

    const finishReason = result.stopReason === "completed" ? "stop" : "length";

    if (streamState) {
      // Cover synthesized finals (or non-streaming backends) that never
      // fired onDelta.
      const text = result.text ?? "";
      if (!streamState.streamed && text) {
        streamState.writeContent(text);
        streamState.streamed = text;
      } else if (text.startsWith(streamState.streamed) && text.length > streamState.streamed.length) {
        const rest = text.slice(streamState.streamed.length);
        streamState.writeContent(rest);
        streamState.streamed = text;
      }
      streamState.finish(finishReason);
      return;
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
  } catch (err) {
    if (abort.signal.aborted) {
      if (streamState && !res.writableEnded) res.end();
      return;
    }
    if (streamState) {
      // Headers already sent — best-effort close without a JSON error body.
      if (!res.writableEnded) {
        try {
          streamState.finish("stop");
        } catch {
          res.end();
        }
      }
      return;
    }
    throw err;
  } finally {
    req.off("close", onClientGone);
  }
}

/**
 * Pick / validate the model for one chat request. Image attachments require
 * a vision-capable model; when the request omits `model` (or sends `auto`)
 * prefer the configured tier band's `vision` model, then the serve default
 * when it already has vision, then auto-select tools+vision.
 *
 * @param {object} options
 * @param {string|undefined} options.requested
 * @param {string} options.defaultModel
 * @param {{show?: Function, listModelsDetailed?: Function}} options.client
 * @param {boolean} options.requireVision
 * @param {import("./tier-models.mjs").TierModelBand[]|null} [options.tierModels]
 * @param {number} [options.defaultTier]
 * @returns {Promise<string|undefined>}
 */
async function resolveRequestModel({
  requested,
  defaultModel,
  client,
  requireVision,
  tierModels = null,
  defaultTier = 2,
}) {
  const pinned = requested && requested !== "auto" ? requested : undefined;

  if (!requireVision) {
    if (pinned) assertToolCapable(pinned);
    return pinned;
  }

  if (pinned) {
    if (typeof client?.show === "function" || typeof client?.listModelsDetailed === "function") {
      try {
        const { tools, vision } = await detectCapabilities(client, pinned);
        if (tools === false) {
          throw new ModelRoutingError(
            `Model '${pinned}' does not support tool calling. Choose a tool-capable model.`,
          );
        }
        if (vision === false) {
          throw new ModelRoutingError(
            `Model '${pinned}' does not support images. Choose a vision-capable model or omit model to auto-select.`,
          );
        }
        if (tools === null) assertToolCapable(pinned);
        if (vision === null) assertVisionCapable(pinned);
        return pinned;
      } catch (err) {
        if (err instanceof ModelRoutingError) throw err;
        assertToolCapable(pinned);
        assertVisionCapable(pinned);
        return pinned;
      }
    }
    assertToolCapable(pinned);
    assertVisionCapable(pinned);
    return pinned;
  }

  // Prefer the tier band's configured vision model when bands are available.
  if (tierModels?.length) {
    const fromTier = resolveTierModel(defaultTier, tierModels, null, { requireVision: true });
    if (fromTier) {
      try {
        const routed = await resolveModelAuto({
          requested: fromTier,
          client,
          requireVision: true,
        });
        return routed.model;
      } catch (err) {
        if (!(err instanceof ModelRoutingError)) throw err;
        // Tier vision model missing / unsuitable — fall through.
      }
    }
  }

  // No pin (or auto): prefer the serve default when it already has vision.
  const candidate = defaultModel && defaultModel !== "auto" && defaultModel !== "unknown"
    ? defaultModel
    : undefined;
  if (candidate && typeof client?.show === "function") {
    try {
      const { tools, vision } = await detectCapabilities(client, candidate);
      if (tools === true && vision === true) return candidate;
    } catch {
      // fall through to auto-select
    }
  }

  if (typeof client?.listModelsDetailed !== "function") {
    if (candidate) {
      assertToolCapable(candidate);
      assertVisionCapable(candidate);
      return candidate;
    }
    throw new ModelRoutingError(
      "Image attachments require a vision-capable model, but none was specified and auto-select is unavailable.",
    );
  }

  const routed = await resolveModelAuto({
    requested: "auto",
    client,
    requireVision: true,
  });
  return routed.model;
}

/**
 * @param {{chat: Function, chatStream?: Function}} client
 * @param {string|undefined} model
 */
function wrapClientForModel(client, model) {
  if (!model) return client;
  const wrapped = {
    chat: (request) => client.chat({ ...request, model }),
  };
  if (typeof client.chatStream === "function") {
    wrapped.chatStream = (request) => client.chatStream({ ...request, model });
  }
  if (typeof client.listModels === "function") {
    wrapped.listModels = (...args) => client.listModels(...args);
  }
  if (typeof client.listModelsDetailed === "function") {
    wrapped.listModelsDetailed = (...args) => client.listModelsDetailed(...args);
  }
  if (typeof client.show === "function") {
    wrapped.show = (...args) => client.show(...args);
  }
  if ("model" in client) wrapped.model = model;
  if ("baseUrl" in client) wrapped.baseUrl = client.baseUrl;
  if ("numCtx" in client) wrapped.numCtx = client.numCtx;
  return wrapped;
}

/**
 * Map an OpenAI messages array onto the loop's (goal, history) contract:
 * the last user message is the goal, everything before it is history, and a
 * system message is injected when the client did not send one. Image parts
 * become Ollama `images` (raw base64) on the corresponding messages.
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

  const goalParts = normalizeContent(messages[lastUserIndex]);
  const before = messages.slice(0, lastUserIndex).map((m) => {
    const { content, images } = normalizeContent(m);
    return {
      role: m.role,
      content,
      ...(images.length ? { images } : {}),
    };
  });
  const history = before.some((m) => m.role === "system")
    ? before
    : [{ role: "system", content: fallbackSystemPrompt }, ...before];
  return {
    goal: goalParts.content,
    history,
    images: goalParts.images,
  };
}

/**
 * Flatten OpenAI content (string or typed parts) to text + Ollama base64 images.
 * @param {object} message
 * @returns {{content: string, images: string[]}}
 */
function normalizeContent(message) {
  const images = [];
  if (Array.isArray(message?.images)) {
    for (const img of message.images) {
      const raw = extractBase64(img);
      if (raw) images.push(raw);
    }
  }

  const content = message?.content;
  if (typeof content === "string") {
    return { content, images };
  }
  if (Array.isArray(content)) {
    const texts = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
        continue;
      }
      if (part.type === "image_url") {
        const raw = extractBase64(part.image_url?.url ?? part.image_url);
        if (raw) images.push(raw);
        continue;
      }
      if (part.type === "input_image") {
        const raw = extractBase64(part.image_url ?? part.url ?? part.data);
        if (raw) images.push(raw);
        continue;
      }
      if (part.type === "image") {
        const raw = extractBase64(
          part.source?.data ?? part.data ?? part.url ?? part.image?.url ?? part.image,
        );
        if (raw) images.push(raw);
      }
    }
    return { content: texts.join("\n"), images };
  }
  return { content: "", images };
}

/** Strip a data-URL prefix; pass through raw base64; ignore remote http(s) URLs. */
function extractBase64(value) {
  if (typeof value !== "string" || !value) return null;
  const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(value);
  if (dataUrl) return dataUrl[1];
  if (/^https?:\/\//i.test(value)) return null;
  // Already-raw base64 from Ollama-style `images` arrays.
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.replace(/\s+/g, "").length >= 32) {
    return value.replace(/\s+/g, "");
  }
  return null;
}

/**
 * Open an SSE completion stream and return helpers to write deltas.
 * @param {http.ServerResponse} res
 * @param {string} model
 */
function beginCompletionStream(res, model) {
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

  return {
    streamed: "",
    writeContent(text) {
      if (!text || res.writableEnded) return;
      res.write(chunk({ content: text }));
    },
    finish(finishReason) {
      if (res.writableEnded) return;
      res.write(chunk({}, finishReason));
      res.write("data: [DONE]\n\n");
      res.end();
    },
  };
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
