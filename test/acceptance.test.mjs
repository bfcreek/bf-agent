import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptanceFailureNudge,
  buildAcceptanceContract,
  buildHeuristicContract,
  parseAcceptanceBlock,
  verifyAcceptanceContract,
} from "../src/acceptance.mjs";

test("parseAcceptanceBlock extracts deliverables and commands", () => {
  const plan = [
    "## Plan",
    "1. write filter.py",
    "## Acceptance",
    "- deliverable: filter.py",
    "- command: python test.py",
    "- output: workspace-relative path only",
  ].join("\n");
  const parsed = parseAcceptanceBlock(plan);
  assert.equal(parsed.checks.length, 2);
  assert.equal(parsed.checks[0].kind, "deliverable");
  assert.equal(parsed.checks[1].kind, "command");
  assert.match(parsed.outputShape, /path only/i);
});

test("buildHeuristicContract picks named deliverables from goal", () => {
  const contract = buildHeuristicContract("Create output file titled results.json from input.csv");
  assert.ok(contract.checks.some((c) => c.kind === "deliverable" && c.target.includes("results.json")));
});

test("buildAcceptanceContract merges plan and heuristic checks", () => {
  const contract = buildAcceptanceContract(
    "write results.json then run node test.mjs",
    "## Acceptance\n- command: node test.mjs",
  );
  assert.ok(contract.checks.some((c) => c.target.includes("node test.mjs")));
});

test("acceptanceFailureNudge lists missing items", () => {
  const nudge = acceptanceFailureNudge({
    passed: false,
    checks: [],
    missing: ["create results.json", "run node test.mjs"],
  });
  assert.match(nudge, /Still required/);
  assert.match(nudge, /results\.json/);
});

test("verifyAcceptanceContract fails when deliverable missing", async () => {
  const contract = buildHeuristicContract("Create output file titled out.txt");
  const result = await verifyAcceptanceContract({
    contract,
    steps: [],
    goal: "Create output file titled out.txt",
    workspaceRoot: process.cwd(),
  });
  assert.equal(result.passed, false);
  assert.ok(result.missing.some((m) => /out\.txt/.test(m)));
});

test("a successful write satisfies a deliverable the workspace probe cannot see", async () => {
  const contract = buildHeuristicContract("Create output file titled out.txt");
  const steps = [
    {
      toolCalls: [{ name: "write_file", ok: true, args: { path: "out.txt" }, result: { path: "out.txt" } }],
    },
  ];

  const result = await verifyAcceptanceContract({
    contract,
    steps,
    goal: "Create output file titled out.txt",
    workspaceRoot: process.cwd(),
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.missing, []);
});

test("a command that exits 0 but prints nothing does not satisfy its check", async () => {
  const contract = { checks: [{ kind: "command", target: "node filter.mjs data.json" }] };
  const silent = [
    {
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "node filter.mjs data.json" },
          result: { exitCode: 0, stdout: "", stderr: "" },
        },
      ],
    },
  ];

  const result = await verifyAcceptanceContract({ contract, steps: silent, goal: "" });

  assert.equal(result.passed, false);
  assert.match(result.checks[0].detail, /printed nothing/i);
});

test("a command that exits 0 with output satisfies its check", async () => {
  const contract = { checks: [{ kind: "command", target: "node filter.mjs data.json" }] };
  const loud = [
    {
      toolCalls: [
        {
          name: "run_command",
          ok: true,
          args: { command: "node filter.mjs data.json" },
          result: { exitCode: 0, stdout: "2 active users\n", stderr: "" },
        },
      ],
    },
  ];

  const result = await verifyAcceptanceContract({ contract, steps: loud, goal: "" });

  assert.equal(result.passed, true);
});

test("heuristic verification gaps are advisory, not gated on", async () => {
  const goal = "implement a new feature and then run the tests to verify";
  const contract = buildAcceptanceContract(goal);

  const result = await verifyAcceptanceContract({
    contract,
    steps: [{ toolCalls: [{ name: "read_file", ok: true, args: { path: "src/foo.mjs" } }] }],
    goal,
    workspaceRoot: process.cwd(),
  });

  assert.equal(result.passed, true, "an empty contract must not block completion");
  assert.ok(result.advisory.length > 0, "the unmet verify heuristic should still be reported");
  assert.equal(acceptanceFailureNudge(result), null);
});
