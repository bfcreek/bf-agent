import assert from "node:assert/strict";
import { test } from "node:test";

import { isLikelyToolCapable, resolveModel } from "../src/model-routing.mjs";

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

test("installed model without tool support is kept but warned about", () => {
  const routed = resolveModel({
    requested: "gemma3:12b",
    installed: ["gemma3:12b", "llama3.2:latest"],
  });
  assert.equal(routed.model, "gemma3:12b");
  assert.match(routed.warnings[0], /does not support tool calling/);
});

test("no installed list means the request passes through untouched", () => {
  assert.deepEqual(resolveModel({ requested: "llama3.2", installed: [] }), {
    model: "llama3.2",
    warnings: [],
  });
});

test("nothing installed is tool-capable: keep request, warn loudly", () => {
  const routed = resolveModel({
    requested: "no-such-model",
    installed: ["gemma3:12b"],
  });
  assert.equal(routed.model, "no-such-model");
  assert.match(routed.warnings[0], /no tool-capable fallback/);
});
