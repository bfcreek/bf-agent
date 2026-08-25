/**
 * Catalog of recognized public benchmarks. Only `status: "ready"` suites run;
 * others exist so the CLI can list what is next without mixing them into the
 * development bench.
 */

/** @typedef {"ready"|"planned"} SuiteStatus */

/**
 * @typedef {object} DatasetSpec
 * @property {string} id Harbor dataset id (`org/name` or `name@version`)
 * @property {string} [label]
 * @property {number|null} [taskCount]
 * @property {string} [notes]
 */

/**
 * @typedef {object} SuiteSpec
 * @property {string} id
 * @property {string[]} aliases
 * @property {SuiteStatus} status
 * @property {string} title
 * @property {string} description
 * @property {string} [defaultDataset]
 * @property {Record<string, DatasetSpec>} [datasets]
 * @property {string} [leaderboard]
 */

/** @type {Record<string, SuiteSpec>} */
export const SUITES = {
  "terminal-bench": {
    id: "terminal-bench",
    aliases: ["tb", "tbench", "terminalbench"],
    status: "ready",
    title: "Terminal-Bench",
    description:
      "Harbor tasks in Docker: the agent uses a shell to make hidden tests pass. Mechanical pass/fail, then the same Cursor CLI judge as the dev bench.",
    defaultDataset: "2.1",
    leaderboard: "https://www.tbench.ai/",
    datasets: {
      "1.0": {
        id: "terminal-bench/terminal-bench@1.0",
        label: "Terminal-Bench 1.0",
        taskCount: 80,
      },
      "2.0": {
        id: "terminal-bench/terminal-bench-2",
        label: "Terminal-Bench 2.0",
        taskCount: 89,
      },
      "2.1": {
        id: "terminal-bench/terminal-bench-2-1",
        label: "Terminal-Bench 2.1",
        taskCount: 89,
        notes: "Preferred shareable set (verified 2.0 tasks).",
      },
      "3.0": {
        id: "terminal-bench/terminal-bench@latest",
        label: "Terminal-Bench 3.0",
        taskCount: null,
        notes: "Frontier difficulty. Expect very low resolve rates.",
      },
    },
  },
  "swe-bench-verified": {
    id: "swe-bench-verified",
    aliases: ["swe-bench", "swebench", "swe-bench-verified"],
    status: "planned",
    title: "SWE-bench Verified",
    description: "500 GitHub issues, % resolved. Not wired yet.",
    leaderboard: "https://www.swebench.com/verified.html",
  },
};

/**
 * @param {string} raw
 * @returns {SuiteSpec|null}
 */
export function resolveSuite(raw) {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  if (SUITES[key]) return SUITES[key];
  return Object.values(SUITES).find((suite) => suite.aliases.includes(key)) ?? null;
}

/** @returns {SuiteSpec[]} */
export function listSuites() {
  return Object.values(SUITES);
}

/**
 * @param {SuiteSpec} suite
 * @param {string} [raw] Alias (`2.1`) or a raw Harbor dataset id
 * @returns {DatasetSpec}
 */
export function resolveDataset(suite, raw) {
  const value = String(raw ?? suite.defaultDataset ?? "").trim();
  if (!value) {
    throw new Error(`Suite '${suite.id}' has no dataset selected.`);
  }
  if (suite.datasets?.[value]) return suite.datasets[value];
  if (value.includes("/") || value.includes("@")) {
    return { id: value, label: value, taskCount: null };
  }
  const known = suite.datasets ? Object.keys(suite.datasets).join(", ") : "(none)";
  throw new Error(`Unknown dataset '${value}' for ${suite.id}. Known: ${known}, or a Harbor id like org/name@version.`);
}
