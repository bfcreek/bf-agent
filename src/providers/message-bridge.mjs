/**
 * Translate the loop's Ollama-shaped transcript to OpenAI / Anthropic wire
 * formats at the client boundary. The agent loop keeps using:
 *   assistant.tool_calls[].function.{name,arguments}
 *   tool messages with tool_name + content
 */

/**
 * @param {unknown} args
 * @returns {string}
 */
export function argsToJsonString(args) {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

/**
 * @param {string|object|undefined} args
 * @returns {object}
 */
export function argsToObject(args) {
  if (args && typeof args === "object") return args;
  if (typeof args !== "string" || !args.trim()) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Convert loop messages to OpenAI Chat Completions messages.
 * Assigns stable tool_call ids and remembers them for matching tool results.
 *
 * @param {Array<object>} messages
 * @returns {{ messages: Array<object>, toolCallIds: Map<string, string> }}
 */
export function toOpenAIMessages(messages) {
  /** @type {Map<string, string>} name+index → id, and also id → name */
  const toolCallIds = new Map();
  /** @type {string[]} pending ids in order for nameless tool results */
  const pendingByName = new Map();
  let idCounter = 0;

  const nextId = (name) => {
    idCounter += 1;
    const id = `call_${idCounter}_${String(name ?? "tool").replace(/[^\w-]/g, "_").slice(0, 40)}`;
    return id;
  };

  const out = [];
  for (const msg of messages ?? []) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role;

    if (role === "system" || role === "user") {
      out.push({ role, content: textContent(msg.content) });
      continue;
    }

    if (role === "assistant") {
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (toolCalls.length === 0) {
        out.push({ role: "assistant", content: textContent(msg.content) });
        continue;
      }
      const mapped = toolCalls.map((tc, i) => {
        const name = tc?.function?.name ?? tc?.name ?? `tool_${i}`;
        const id = tc?.id ?? nextId(name);
        toolCallIds.set(id, name);
        const list = pendingByName.get(name) ?? [];
        list.push(id);
        pendingByName.set(name, list);
        return {
          id,
          type: "function",
          function: {
            name,
            arguments: argsToJsonString(tc?.function?.arguments ?? tc?.arguments),
          },
        };
      });
      out.push({
        role: "assistant",
        content: textContent(msg.content) || null,
        tool_calls: mapped,
      });
      continue;
    }

    if (role === "tool") {
      const name = msg.tool_name ?? msg.name ?? "";
      let id = msg.tool_call_id;
      if (!id && name) {
        const list = pendingByName.get(name) ?? [];
        id = list.shift() ?? nextId(name);
        pendingByName.set(name, list);
      }
      if (!id) id = nextId("tool");
      out.push({
        role: "tool",
        tool_call_id: id,
        content: textContent(msg.content),
      });
    }
  }

  return { messages: out, toolCallIds };
}

/**
 * Normalize an OpenAI assistant message into the loop dialect.
 * @param {object} message
 */
export function fromOpenAIMessage(message) {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const content = textContent(message?.content);
  if (toolCalls.length === 0) {
    return { role: "assistant", content };
  }
  return {
    role: "assistant",
    content,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      function: {
        name: tc.function?.name ?? "",
        arguments: argsToObject(tc.function?.arguments),
      },
    })),
  };
}

/**
 * Split loop messages into Anthropic system + messages.
 * @param {Array<object>} messages
 */
export function toAnthropicMessages(messages) {
  /** @type {string[]} */
  const systemParts = [];
  /** @type {Array<object>} */
  const out = [];
  /** @type {Map<string, string[]>} */
  const pendingByName = new Map();
  let idCounter = 0;

  const nextId = (name) => {
    idCounter += 1;
    return `toolu_${idCounter}_${String(name ?? "tool").replace(/[^\w-]/g, "_").slice(0, 40)}`;
  };

  for (const msg of messages ?? []) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "system") {
      const t = textContent(msg.content);
      if (t) systemParts.push(t);
      continue;
    }
    if (msg.role === "user") {
      out.push({ role: "user", content: textContent(msg.content) });
      continue;
    }
    if (msg.role === "assistant") {
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (toolCalls.length === 0) {
        out.push({ role: "assistant", content: textContent(msg.content) });
        continue;
      }
      /** @type {Array<object>} */
      const content = [];
      const text = textContent(msg.content);
      if (text) content.push({ type: "text", text });
      for (const tc of toolCalls) {
        const name = tc?.function?.name ?? tc?.name ?? "tool";
        const id = tc?.id ?? nextId(name);
        const list = pendingByName.get(name) ?? [];
        list.push(id);
        pendingByName.set(name, list);
        content.push({
          type: "tool_use",
          id,
          name,
          input: argsToObject(tc?.function?.arguments ?? tc?.arguments),
        });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    if (msg.role === "tool") {
      const name = msg.tool_name ?? msg.name ?? "";
      let id = msg.tool_call_id;
      if (!id && name) {
        const list = pendingByName.get(name) ?? [];
        id = list.shift() ?? nextId(name);
        pendingByName.set(name, list);
      }
      if (!id) id = nextId("tool");
      // Anthropic wants tool_result on a user turn.
      const last = out[out.length - 1];
      const block = {
        type: "tool_result",
        tool_use_id: id,
        content: textContent(msg.content),
      };
      if (last?.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }

  return { system: systemParts.join("\n\n"), messages: out };
}

/**
 * Normalize an Anthropic Messages API response into the loop dialect.
 * @param {object} response
 */
export function fromAnthropicResponse(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const textParts = [];
  const toolCalls = [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block?.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        function: {
          name: block.name ?? "",
          arguments: block.input && typeof block.input === "object" ? block.input : {},
        },
      });
    }
  }
  const content = textParts.join("");
  if (toolCalls.length === 0) return { role: "assistant", content };
  return { role: "assistant", content, tool_calls: toolCalls };
}

/** OpenAI-style tool schemas → Anthropic tools. */
export function toAnthropicTools(tools) {
  return (tools ?? []).map((t) => {
    const fn = t?.function ?? t;
    return {
      name: fn?.name ?? "",
      description: fn?.description ?? "",
      input_schema: fn?.parameters ?? { type: "object", properties: {} },
    };
  });
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function textContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return String(part.text ?? "");
        return "";
      })
      .join("");
  }
  if (content == null) return "";
  return String(content);
}
