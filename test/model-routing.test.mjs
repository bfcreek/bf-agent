import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertToolCapable,
  detectToolCapable,
  isLikelyToolCapable,
  listClassifiedModels,
  listClassifiedModelsDetected,
  ModelRoutingError,
  resolveModel,
  resolveModelDetected,
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
