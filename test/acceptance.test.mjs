import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptanceFailureNudge,
  buildAcceptanceContract,
  buildHeuristicContract,
  contractHasEnforceableChecks,
  isDeliverableOutstandingOnly,
  isVerifyOutstandingOnly,
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

test("heuristic verification gaps stay advisory; empty contracts fail on work goals", async () => {
  const goal = "implement a new feature and then run the tests to verify";
  const contract = buildAcceptanceContract(goal);

  const result = await verifyAcceptanceContract({
    contract,
    steps: [{ toolCalls: [{ name: "read_file", ok: true, args: { path: "src/foo.mjs" } }] }],
    goal,
    workspaceRoot: process.cwd(),
  });

  assert.equal(result.passed, false, "an empty contract is not a pass on a work goal");
  assert.ok(result.missing.some((m) => /empty acceptance contract/i.test(m)));
  assert.ok(result.advisory.length > 0, "the unmet verify heuristic should still be reported");
  assert.equal(acceptanceFailureNudge(result), null, "tool work with a vacuous contract must not stall");
});

test("empty contracts still pass on question goals", async () => {
  const result = await verifyAcceptanceContract({
    contract: { checks: [], source: "heuristic" },
    steps: [],
    goal: "What does README.md say about setup?",
    workspaceRoot: process.cwd(),
  });
  assert.equal(result.passed, true);
});

test("an always-true diagnostic command is not a passing contract", async () => {
  const goal = "implement a new feature and then run the tests to verify";
  const result = await verifyAcceptanceContract({
    contract: { checks: [{ kind: "command", target: "echo ok" }], source: "plan" },
    steps: [
      {
        toolCalls: [
          {
            name: "run_command",
            ok: true,
            args: { command: "echo ok" },
            result: { exitCode: 0, stdout: "ok\n", stderr: "" },
          },
        ],
      },
    ],
    goal,
    workspaceRoot: process.cwd(),
  });
  assert.equal(result.passed, false);
  assert.ok(result.missing.some((m) => /always-true acceptance contract/i.test(m)));
  assert.equal(acceptanceFailureNudge(result), null, "vacuous contracts must not stall");
});

test("instruction-named verify commands are gated even when the plan authored a weak check", async () => {
  const goal = "port the script to Python and then run python eval.py";
  const result = await verifyAcceptanceContract({
    contract: { checks: [{ kind: "command", target: "echo done" }], source: "plan" },
    steps: [
      {
        toolCalls: [
          {
            name: "run_command",
            ok: true,
            args: { command: "echo done" },
            result: { exitCode: 0, stdout: "done\n", stderr: "" },
          },
        ],
      },
    ],
    goal,
    workspaceRoot: process.cwd(),
  });
  assert.equal(result.passed, false);
  assert.ok(result.missing.some((m) => /eval\.py/i.test(m)));
  assert.match(acceptanceFailureNudge(result) ?? "", /eval\.py/i);
});

test("a failed work command without recovery is not a pass", async () => {
  const goal = "implement a new feature and then run the tests to verify";
  const result = await verifyAcceptanceContract({
    contract: { checks: [{ kind: "command", target: "node test.mjs" }], source: "plan" },
    steps: [
      {
        toolCalls: [
          {
            name: "run_command",
            ok: true,
            args: { command: "node test.mjs" },
            result: { exitCode: 1, stdout: "fail\n", stderr: "" },
          },
        ],
      },
    ],
    goal,
    workspaceRoot: process.cwd(),
  });
  assert.equal(result.passed, false);
  assert.ok(result.missing.some((m) => /non-zero/i.test(m)));
});

test("an empty written deliverable is not a pass", async () => {
  const contract = { checks: [{ kind: "deliverable", target: "out.txt" }] };
  const result = await verifyAcceptanceContract({
    contract,
    steps: [
      {
        toolCalls: [
          {
            name: "write_file",
            ok: true,
            args: { path: "out.txt", content: "" },
            result: { path: "out.txt" },
          },
        ],
      },
    ],
    goal: "Create output file titled out.txt",
    workspaceRoot: process.cwd(),
  });
  assert.equal(result.passed, false);
  assert.ok(result.missing.some((m) => /out\.txt/.test(m)));
});

test("instruction sanity-check commands become heuristic acceptance checks", () => {
  const goal =
    "Build the tool. As a sanity check you can run `/usr/local/bin/tool +I/app/in.pov +O/dev/null`.";
  const contract = buildHeuristicContract(goal);
  assert.ok(
    contract.checks.some(
      (c) => c.kind === "command" && /\/usr\/local\/bin\/tool/.test(c.target),
    ),
  );
});

test("isVerifyOutstandingOnly is true only for unmet verify commands", () => {
  assert.equal(
    isVerifyOutstandingOnly({
      passed: false,
      missing: ["run python eval.py"],
      checks: [],
    }),
    true,
  );
  assert.equal(
    isVerifyOutstandingOnly({
      passed: false,
      missing: ["create out.txt"],
      checks: [],
    }),
    false,
  );
  assert.equal(
    isVerifyOutstandingOnly({
      passed: false,
      missing: ["empty acceptance contract is not a pass — derive deliverable or verify checks from the goal"],
      checks: [],
    }),
    false,
  );
  assert.equal(
    isVerifyOutstandingOnly({
      passed: false,
      missing: [
        "no deliverable work happened — run a tool that produces or verifies the result",
      ],
      checks: [],
    }),
    false,
  );
});

test("isDeliverableOutstandingOnly is true only for unmet create paths", () => {
  assert.equal(
    isDeliverableOutstandingOnly({
      passed: false,
      missing: ["create /app/secret.txt"],
      checks: [],
    }),
    true,
  );
  assert.equal(
    isDeliverableOutstandingOnly({
      passed: false,
      missing: ["create out.txt", "create report.md"],
      checks: [],
    }),
    true,
  );
  assert.equal(
    isDeliverableOutstandingOnly({
      passed: false,
      missing: ["create out.txt", "run node out.txt"],
      checks: [],
    }),
    false,
  );
  assert.equal(
    isDeliverableOutstandingOnly({
      passed: false,
      missing: ["empty acceptance contract is not a pass — derive deliverable or verify checks from the goal"],
      checks: [],
    }),
    false,
  );
});

test("acceptanceFailureNudge forces write_file when only deliverables remain", () => {
  const nudge = acceptanceFailureNudge({
    passed: false,
    missing: ["create /app/out.txt"],
    checks: [{ kind: "deliverable", target: "/app/out.txt", passed: false, detail: "missing" }],
  });
  assert.match(nudge ?? "", /write_file/i);
  assert.match(nudge ?? "", /\/app\/out\.txt/);
});

test("parseAcceptanceBlock reads bold labels and extensionless binaries", () => {
  const plan = [
    "## Acceptance",
    "- **Deliverable**: `/app/sqlite/bin/sqlite3` must exist and be executable.",
    "- **Command**: `/app/sqlite/bin/sqlite3 --version` must exit 0 with a version string.",
  ].join("\n");
  const parsed = parseAcceptanceBlock(plan);
  assert.ok(parsed.checks.some((c) => c.kind === "deliverable" && /sqlite3$/.test(c.target)));
  assert.ok(
    parsed.checks.some((c) => c.kind === "command" && /sqlite3 --version/.test(c.target)),
  );
});

test("a work goal with no tools is not a passing contract", async () => {
  const goal =
    "Compile SQLite in /app/sqlite with gcov instrumentation and make it available in the PATH.";
  const result = await verifyAcceptanceContract({
    contract: { checks: [], source: "heuristic" },
    steps: [],
    goal,
    workspaceRoot: process.cwd(),
  });
  assert.equal(result.passed, false);
  assert.ok(result.missing.some((m) => /no deliverable work happened/i.test(m)));
  assert.equal(
    acceptanceFailureNudge(result),
    null,
    "premature tool nudges already cover zero-tool finishes; do not stall again",
  );
});

test("an input/vendor deliverable does not count as done", async () => {
  const goal = "Compile the project in /app/out using the snapshot under /app/vendor/src.tar.gz.";
  const result = await verifyAcceptanceContract({
    contract: {
      checks: [{ kind: "deliverable", target: "/app/vendor/src.tar.gz" }],
      source: "plan",
    },
    steps: [],
    goal,
    workspaceRoot: process.cwd(),
  });
  assert.equal(result.passed, false);
  assert.ok(result.missing.some((m) => /always-true|no deliverable work/i.test(m)));
});

test("mergeAcceptanceContracts is monotone — replans cannot drop named checks", async () => {
  const { mergeAcceptanceContracts } = await import("../src/acceptance.mjs");
  const first = {
    checks: [
      { kind: "deliverable", target: "ars.R" },
      { kind: "command", target: "Rscript test_ars.R" },
    ],
    outputShape: "TEST_NAME: PASS lines",
    source: "plan",
  };
  const shrunk = {
    checks: [{ kind: "deliverable", target: "ars.R" }],
    outputShape: "",
    source: "plan",
  };

  const merged = mergeAcceptanceContracts(first, shrunk);
  assert.equal(merged.checks.length, 2, "the dropped verify command must be carried forward");
  assert.ok(merged.checks.some((c) => c.target === "Rscript test_ars.R"));
  assert.equal(merged.outputShape, "TEST_NAME: PASS lines");
  assert.equal(merged.source, "merged");

  assert.equal(
    mergeAcceptanceContracts(null, shrunk),
    shrunk,
    "no prior contract passes the new one through",
  );
  const identical = mergeAcceptanceContracts(shrunk, shrunk);
  assert.equal(identical.checks.length, 1, "duplicate targets are not doubled");
});

test("contractHasEnforceableChecks separates real checks from vacuous ones", () => {
  assert.equal(contractHasEnforceableChecks(null), false);
  assert.equal(contractHasEnforceableChecks({ checks: [] }), false);
  assert.equal(
    contractHasEnforceableChecks({
      checks: [{ kind: "command", target: "node -v" }],
    }),
    false,
    "a diagnostic-only contract is not enforceable",
  );
  assert.equal(
    contractHasEnforceableChecks({
      checks: [{ kind: "deliverable", target: "/app/vendor/src.tar.gz" }],
    }),
    false,
    "an input path is not an enforceable deliverable",
  );
  assert.equal(
    contractHasEnforceableChecks({
      checks: [
        { kind: "command", target: "node -v" },
        { kind: "deliverable", target: "out/report.json" },
      ],
    }),
    true,
    "one real deliverable makes the contract enforceable",
  );
  assert.equal(
    contractHasEnforceableChecks({
      checks: [{ kind: "command", target: "python test.py" }],
    }),
    true,
  );
});
