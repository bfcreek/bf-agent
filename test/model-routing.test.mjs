import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertToolCapable,
  detectToolCapable,
  isCloudModel,
  isLikelyThinkingCapable,
  isLikelyToolCapable,
  listClassifiedModels,
  listClassifiedModelsDetected,
  MIN_EFFECTIVE_PARAMS_B,
  ModelRoutingError,
  parseParamsBillions,
  resolveModel,
  resolveModelAuto,
  resolveModelDetected,
  suggestModel,
} from "../src/model-routing.mjs";

/** Client whose /api/show reports scripted capabilities per model. */
function makeShowClient(capabilitiesByModel) {
  return {
    async show({ model }) {
      const capabilities = capabilitiesByModel[model];
      if (!capabilities) throw new Error(`model '${model}' not found`);
      return { capabilities };
    },
  };
}

test("known tool-capable families are detected", () => {
  for (const name of [
    "llama3.2",
    "llama3.2:latest",
    "qwen3-coder:30b",
    "qwen2.5:14b-instruct",
    "mistral-nemo:latest",
    "devstral-small-2:latest",
    "gpt-oss:20b",
  ]) {
    assert.equal(isLikelyToolCapable(name), true, name);
  }
});

test("known non-tool families are detected", () => {
  for (const name of [
    "gemma3:12b",
    "llava:7b",
    "minicpm-v:latest",
    "nomic-embed-text:latest",
    "llama2-uncensored:7b",
    "qwen2.5vl:32b",
  ]) {
    assert.equal(isLikelyToolCapable(name), false, name);
  }
});

test("unknown families return null rather than a guess", () => {
  assert.equal(isLikelyToolCapable("some-brand-new-model:7b"), null);
});

test("assertToolCapable accepts known tool-capable models", () => {
  assertToolCapable("llama3.2:latest");
});

test("assertToolCapable rejects known non-tool models", () => {
  assert.throws(() => assertToolCapable("gemma3:12b"), {
    name: "ModelRoutingError",
    message: /does not support tool calling/,
  });
});

test("assertToolCapable rejects unknown families", () => {
  assert.throws(() => assertToolCapable("some-brand-new-model:7b"), {
    name: "ModelRoutingError",
    message: /not a known tool-capable family/,
  });
});

test("exact installed match is used as-is", () => {
  const routed = resolveModel({
    requested: "qwen3-coder:30b",
    installed: ["llama3.2:latest", "qwen3-coder:30b"],
  });
  assert.deepEqual(routed, { model: "qwen3-coder:30b", warnings: [] });
});

test("untagged request matches the :latest tag", () => {
  const routed = resolveModel({
    requested: "llama3.2",
    installed: ["llama3.2:latest"],
  });
  assert.equal(routed.model, "llama3.2:latest");
  assert.deepEqual(routed.warnings, []);
});

test("untagged request matches any tag of the same base name", () => {
  const routed = resolveModel({
    requested: "qwen2.5",
    installed: ["qwen2.5:14b-instruct"],
  });
  assert.equal(routed.model, "qwen2.5:14b-instruct");
});

test("missing model falls back to the first tool-capable installed model", () => {
  const routed = resolveModel({
    requested: "no-such-model",
    installed: ["gemma3:12b", "llava:7b", "qwen3-coder:30b"],
  });
  assert.equal(routed.model, "qwen3-coder:30b");
  assert.match(routed.warnings[0], /not installed; falling back to 'qwen3-coder:30b'/);
});

test("installed model without tool support is rejected", () => {
  assert.throws(
    () =>
      resolveModel({
        requested: "gemma3:12b",
        installed: ["gemma3:12b", "llama3.2:latest"],
      }),
    ModelRoutingError,
  );
});

test("no installed list allows known tool-capable models with a warning", () => {
  const routed = resolveModel({ requested: "llama3.2", installed: [] });
  assert.equal(routed.model, "llama3.2");
  assert.match(routed.warnings[0], /Could not verify/);
});

test("no installed list rejects unknown families", () => {
  assert.throws(
    () => resolveModel({ requested: "some-brand-new-model", installed: [] }),
    ModelRoutingError,
  );
});

test("nothing installed is tool-capable: reject", () => {
  assert.throws(
    () =>
      resolveModel({
        requested: "no-such-model",
        installed: ["gemma3:12b"],
      }),
    {
      name: "ModelRoutingError",
      message: /no tool-capable model was found/,
    },
  );
});

test("listClassifiedModels groups installed models by compliance", () => {
  const classified = listClassifiedModels([
    "qwen3-coder:30b",
    "llama3.2:latest",
    "gemma3:12b",
    "nomic-embed-text:latest",
    "some-brand-new-model:7b",
  ]);
  assert.deepEqual(classified.compliant, ["llama3.2:latest", "qwen3-coder:30b"]);
  assert.deepEqual(classified.notCompliant, ["gemma3:12b", "nomic-embed-text:latest"]);
  assert.deepEqual(classified.unknown, ["some-brand-new-model:7b"]);
});

test("listClassifiedModels handles an empty list", () => {
  assert.deepEqual(listClassifiedModels([]), {
    compliant: [],
    notCompliant: [],
    unknown: [],
  });
});

test("detectToolCapable trusts /api/show capabilities over the family list", async () => {
  const client = makeShowClient({
    // Unknown family that actually supports tools.
    "brand-new-agent:7b": ["completion", "tools"],
    // Family the regexes call tool-capable, but this build lacks tools.
    "llama3.2:latest": ["completion"],
  });
  assert.equal(await detectToolCapable(client, "brand-new-agent:7b"), true);
  assert.equal(await detectToolCapable(client, "llama3.2:latest"), false);
});

test("detectToolCapable falls back to the family list when show fails or is missing", async () => {
  const failing = makeShowClient({}); // every show() throws
  assert.equal(await detectToolCapable(failing, "llama3.2:latest"), true);
  assert.equal(await detectToolCapable(undefined, "gemma3:12b"), false);
  assert.equal(await detectToolCapable(undefined, "some-brand-new-model:7b"), null);
});

test("resolveModelDetected accepts an unknown family that reports tools capability", async () => {
  const client = makeShowClient({ "brand-new-agent:7b": ["completion", "tools"] });
  const routed = await resolveModelDetected({
    requested: "brand-new-agent:7b",
    installed: ["brand-new-agent:7b"],
    client,
  });
  assert.deepEqual(routed, { model: "brand-new-agent:7b", warnings: [] });
});

test("resolveModelDetected rejects a model whose capabilities lack tools", async () => {
  const client = makeShowClient({ "llama3.2:latest": ["completion"] });
  await assert.rejects(
    () =>
      resolveModelDetected({
        requested: "llama3.2",
        installed: ["llama3.2:latest"],
        client,
      }),
    { name: "ModelRoutingError", message: /does not support tool calling/ },
  );
});

test("resolveModelDetected runs unverifiable installed models with a warning", async () => {
  const routed = await resolveModelDetected({
    requested: "some-brand-new-model:7b",
    installed: ["some-brand-new-model:7b"],
    // no client — regexes cannot classify it either
  });
  assert.equal(routed.model, "some-brand-new-model:7b");
  assert.match(routed.warnings[0], /Could not verify/);
});

test("resolveModelDetected falls back using detected capabilities", async () => {
  const client = makeShowClient({
    "gemma3:12b": ["completion"],
    "brand-new-agent:7b": ["completion", "tools"],
  });
  const routed = await resolveModelDetected({
    requested: "no-such-model",
    installed: ["gemma3:12b", "brand-new-agent:7b"],
    client,
  });
  assert.equal(routed.model, "brand-new-agent:7b");
  assert.match(routed.warnings[0], /falling back/);
});

const GB = 1e9;

/** Full auto-selection client: detailed tags list + scripted capabilities. */
function makeAutoClient(entries) {
  return {
    async listModelsDetailed() {
      return entries.map(({ name, sizeBytes = 0, parameterSize = "" }) => ({
        name,
        sizeBytes,
        parameterSize,
      }));
    },
    async show({ model }) {
      const entry = entries.find((e) => e.name === model);
      if (!entry?.capabilities) throw new Error(`model '${model}' not found`);
      return { capabilities: entry.capabilities };
    },
  };
}

const THINKING_TOOLS = ["completion", "tools", "thinking"];
const TOOLS_ONLY = ["completion", "tools"];

test("parseParamsBillions parses B/M/T strings and estimates from file size", () => {
  assert.equal(parseParamsBillions("20.9B"), 20.9);
  assert.equal(parseParamsBillions("1T"), 1000);
  assert.equal(parseParamsBillions("500M"), 0.5);
  assert.equal(parseParamsBillions("8.0B", 999 * GB), 8);
  // no string: ~0.6 bytes/param estimate
  assert.equal(Math.round(parseParamsBillions("", 12 * GB)), 20);
  assert.equal(parseParamsBillions("", 0), 0);
});

test("isCloudModel matches Ollama cloud naming", () => {
  assert.equal(isCloudModel("gpt-oss:120b-cloud"), true);
  assert.equal(isCloudModel("glm-4.6:cloud"), true);
  assert.equal(isCloudModel("qwen3-coder:30b"), false);
  assert.equal(isCloudModel("cloudy-model:7b"), false);
});

test("isLikelyThinkingCapable knows thinking families; qwen3-coder is not one", () => {
  assert.equal(isLikelyThinkingCapable("qwen3:14b"), true);
  assert.equal(isLikelyThinkingCapable("gpt-oss:20b"), true);
  assert.equal(isLikelyThinkingCapable("qwen3-coder:30b"), null);
  assert.equal(isLikelyThinkingCapable("llama3.2:latest"), null);
});

test("suggestModel picks the strongest local thinking+tools model that fits", async () => {
  const client = makeAutoClient([
    { name: "qwen3:14b", sizeBytes: 9 * GB, parameterSize: "14.8B", capabilities: THINKING_TOOLS },
    { name: "gpt-oss:20b", sizeBytes: 13 * GB, parameterSize: "20.9B", capabilities: THINKING_TOOLS },
    // Bigger but non-thinking: excluded despite tools.
    { name: "qwen3-coder:30b", sizeBytes: 18 * GB, parameterSize: "30.5B", capabilities: TOOLS_ONLY },
    // Thinking but too big for the memory budget.
    { name: "gpt-oss:120b", sizeBytes: 65 * GB, parameterSize: "116.8B", capabilities: THINKING_TOOLS },
  ]);
  const picked = await suggestModel({
    client,
    models: await client.listModelsDetailed(),
    totalMemBytes: 64 * GB, // budget = 32 GB
  });
  assert.equal(picked.model, "gpt-oss:20b");
  assert.equal(picked.cloud, false);
});

test("suggestModel skips models below the effectiveness floor", async () => {
  const client = makeAutoClient([
    { name: "tiny-thinker:1.5b", sizeBytes: 1 * GB, parameterSize: "1.5B", capabilities: THINKING_TOOLS },
    { name: "qwen3:8b", sizeBytes: 5 * GB, parameterSize: "8.2B", capabilities: THINKING_TOOLS },
  ]);
  const picked = await suggestModel({
    client,
    models: await client.listModelsDetailed(),
    totalMemBytes: 32 * GB,
  });
  assert.equal(picked.model, "qwen3:8b");
  assert.ok(MIN_EFFECTIVE_PARAMS_B > 1.5, "floor excludes the tiny model");
});

test("suggestModel falls back to an installed cloud model when no local qualifies", async () => {
  const client = makeAutoClient([
    // Local: too small, or non-thinking, or does not fit.
    { name: "llama3.2:latest", sizeBytes: 2 * GB, parameterSize: "3.2B", capabilities: TOOLS_ONLY },
    { name: "gpt-oss:120b", sizeBytes: 65 * GB, parameterSize: "116.8B", capabilities: THINKING_TOOLS },
    // Cloud: no memory constraint.
    { name: "gpt-oss:120b-cloud", sizeBytes: 400, parameterSize: "116.8B", capabilities: THINKING_TOOLS },
  ]);
  const picked = await suggestModel({
    client,
    models: await client.listModelsDetailed(),
    totalMemBytes: 32 * GB,
  });
  assert.equal(picked.model, "gpt-oss:120b-cloud");
  assert.equal(picked.cloud, true);
  assert.match(picked.reason, /no local model is strong enough/);
});

test("suggestModel returns null when nothing qualifies", async () => {
  const client = makeAutoClient([
    { name: "llama3.2:latest", sizeBytes: 2 * GB, parameterSize: "3.2B", capabilities: TOOLS_ONLY },
  ]);
  const picked = await suggestModel({
    client,
    models: await client.listModelsDetailed(),
    totalMemBytes: 32 * GB,
  });
  assert.equal(picked, null);
});

test("resolveModelAuto with auto picks via suggestModel and explains itself", async () => {
  const client = makeAutoClient([
    { name: "qwen3:14b", sizeBytes: 9 * GB, parameterSize: "14.8B", capabilities: THINKING_TOOLS },
  ]);
  const routed = await resolveModelAuto({ requested: "auto", client, totalMemBytes: 64 * GB });
  assert.equal(routed.model, "qwen3:14b");
  assert.match(routed.warnings[0], /Using 'qwen3:14b'/);
});

test("resolveModelAuto errors with guidance when nothing is suitable", async () => {
  const client = makeAutoClient([
    { name: "llama3.2:latest", sizeBytes: 2 * GB, parameterSize: "3.2B", capabilities: TOOLS_ONLY },
  ]);
  await assert.rejects(
    () => resolveModelAuto({ requested: "auto", client, totalMemBytes: 32 * GB }),
    { name: "ModelRoutingError", message: /ollama pull/i },
  );
});

test("resolveModelAuto honors an explicit weak model but warns", async () => {
  const client = makeAutoClient([
    { name: "llama3.2:latest", sizeBytes: 2 * GB, parameterSize: "3.2B", capabilities: TOOLS_ONLY },
  ]);
  const routed = await resolveModelAuto({
    requested: "llama3.2",
    client,
    totalMemBytes: 32 * GB,
  });
  assert.equal(routed.model, "llama3.2:latest");
  assert.match(routed.warnings[0], /may be too weak/);
});

test("resolveModelAuto rejects an explicit model without tool support", async () => {
  const client = makeAutoClient([
    { name: "gemma3:12b", sizeBytes: 8 * GB, parameterSize: "12.2B", capabilities: ["completion"] },
  ]);
  await assert.rejects(
    () => resolveModelAuto({ requested: "gemma3:12b", client, totalMemBytes: 32 * GB }),
    { name: "ModelRoutingError", message: /does not support tool calling/ },
  );
});

test("resolveModelAuto auto-selects when the explicit model is not installed", async () => {
  const client = makeAutoClient([
    { name: "qwen3:14b", sizeBytes: 9 * GB, parameterSize: "14.8B", capabilities: THINKING_TOOLS },
  ]);
  const routed = await resolveModelAuto({
    requested: "no-such-model",
    client,
    totalMemBytes: 64 * GB,
  });
  assert.equal(routed.model, "qwen3:14b");
  assert.match(routed.warnings[0], /not installed; auto-selecting/);
});

test("listClassifiedModelsDetected groups by probed capabilities", async () => {
  const client = makeShowClient({
    "brand-new-agent:7b": ["completion", "tools"],
    "llama3.2:latest": ["completion"],
  });
  const classified = await listClassifiedModelsDetected(client, [
    "brand-new-agent:7b",
    "llama3.2:latest",
    "some-brand-new-model:7b", // show fails, regexes unknown
  ]);
  assert.deepEqual(classified.compliant, ["brand-new-agent:7b"]);
  assert.deepEqual(classified.notCompliant, ["llama3.2:latest"]);
  assert.deepEqual(classified.unknown, ["some-brand-new-model:7b"]);
});
