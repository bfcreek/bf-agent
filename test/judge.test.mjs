import assert from "node:assert/strict";
import { test } from "node:test";

import { inferAgentStopReason } from "../evals/recognized/judge.mjs";

test("inferAgentStopReason marks empty crash sessions as error", () => {
  assert.equal(
    inferAgentStopReason({ steps: [], messages: [], stopReason: "completed" }, {
      stdout: "NonZeroAgentExitCodeError: agent exited with code 3",
    }),
    "error",
  );
  assert.equal(
    inferAgentStopReason({ steps: [], error: "error parsing tool call" }),
    "error",
  );
  assert.equal(
    inferAgentStopReason({ steps: [{ index: 1 }], stopReason: "completed" }),
    "completed",
  );
  assert.equal(inferAgentStopReason(null, { stdout: "" }), "completed");
});
