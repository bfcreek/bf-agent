/**
 * Prompt enhancements for weaker models: task-type heuristics, a planning
 * pre-pass on first turns, and Ollama native-thinking configuration.
 */

import { detectCapabilities, parseParamsBillions } from "./model-routing.mjs";

export const COMPLEX_GOAL_MIN_WORDS = 10;

/**
 * Empty-workspace / app-skeleton goals. Distinct from "write a shell script":
 * "the shell of an Electron app" means the project skeleton.
 * @param {string} goal
 * @returns {boolean}
 */
export function isGreenfieldScaffoldGoal(goal) {
  const text = String(goal ?? "");
  if (/\b(?:bash|powershell)\s+scripts?\b|\bshell\s+scripts?\b/i.test(text)) {
    if (!/\b(?:empty workspace|workspace is empty|from scratch|scaffold|electron\s+app)\b/i.test(text)) {
      return false;
    }
  }
  return (
    /\b(?:empty workspace|workspace is empty|from scratch|scaffold)\b/i.test(text) ||
    /\b(?:create|build|make)\b.{0,100}\b(?:the\s+)?shell\s+(?:of|for)\b/i.test(text) ||
    /\b(?:app|application|project|electron)\s+shell\b/i.test(text) ||
    /\b(?:create|build|make)\b.{0,80}\belectron\b/i.test(text)
  );
}

/**
 * Task-type patterns. First match wins per category; multiple categories
 * can apply. Keep constraints short — they ride in the user message.
 */
const TASK_HINT_RULES = [
  {
    id: "artifact-only",
    test: (text) => isArtifactOnlyGoal(text),
    constraint:
      "This is artifact-only: read the named input files, compute the result, write_file the output path. Do not hunt for test.mjs/test.py — the instruction did not name them. After write_file, read_file the output to confirm format, then finish.",
  },
  {
    id: "password-crack",
    test: /\b(crack|john|hashcat|7z|password|brute.?force|dictionary)\b/i,
    constraint:
      "If the workspace includes task-named tooling (john/, hashcat, bundled scripts), build from ./john/src instead of apt install john when sources are present. When grep finds *2john converters (7z2john.pl, zip2john), run the converter on the archive, build john if needed, then john --wordlist=… — confirm the wordlist path exists first (apt-get install -y wamerican or /usr/share/wordlists). Do not guess passwords by hand first. For 7z: exit 0 with 'No files to process' or 'Files: 0' is not successful extraction — confirm decrypted files exist on disk before finishing. After write_file of the deliverable, read_file it and validate contents before finishing.",
  },
  {
    id: "test-fix",
    test: /\b(failing tests?|tests?\s+fail|\bit fails?\b|fix.{0,60}\btests?\b|(?:test|spec|suite).{0,40}\b(fail|fails|broken|error)\b)\b/i,
    constraint:
      "Mandatory first step: run_command the failing test (e.g. node test.mjs, python test.py, or dotnet run) and record exit code/output before any edit_file or write_file. If that run already exits 0, read the named implementation file, confirm it matches the tests, and finish — do not add validation, docstrings, or extra features. If it fails, fix only the broken logic, then re-run the same command. Checklist: reproduce → diagnose → fix → verify. Do not rewrite the test file. After the failing run, edit_file the named implementation immediately (often inverted operators or swapped return values), then re-run the same test command. If edit_file says old_string is ambiguous, include the enclosing def/class (e.g. def mul(a, b): plus the return line) and never set replace_all on a return/statement. If a Python test imports a function whose module has the same name (greet.py / greet()), use `from greet import greet` — `import greet` then greet() calls the module.",
  },
  {
    id: "merge-conflict",
    test: /\b(merge conflict|git merge|unmerged|conflict markers?)\b|\b<<<<<<<\b/i,
    constraint:
      "After a merge CONFLICT, do not stop after inspecting both sides (git show). Required loop: edit_file or write_file to remove <<<<<<< markers → git add and git commit → run the named verification (e.g. examples.json). Empty answers and git show of both versions are not completion.",
  },
  {
    id: "debug",
    test: /\b(debug|diagnose|troubleshoot)\b|\bwhy (?:is|does|isn't|doesn't)\b|\bnot working\b|\b(?:is|are) broken\b/i,
    constraint:
      "Reproduce the issue first (read logs, run the failing command). Form a hypothesis before changing code.",
  },
  {
    id: "rename-typo",
    test: /\b(misspell|typo|renam\w*|fix the (?:typo|spelling)|handeler|identifier)\b/i,
    constraint:
      "Scan the file for every declaration, export, and reference of the misspelled identifier. Update them all in one edit_file with replace_all: true before running tests.",
  },
  {
    id: "search",
    test: /\b(where is|find|locate|search for|look for|which file)\b.{0,80}\b(defin(?:ed|ition|es)|used|implemented|exports?)\b/i,
    constraint:
      "Use grep_search (or find_files) to locate symbols — do not list_dir to hunt for a definition. Prefer the file that defines the symbol, not an import/call site. After the search hit, reply with the relative path if that is all the user asked for — do not stop on an empty message.",
  },
  {
    id: "path-answer",
    test:
      /\b(reply with|answer with)\b.{0,40}\b(just|only)\b.{0,40}\b(number|path)\b|\bwhich file\b.{0,80}\b(defin|path|relative)\b|\brelative to the workspace\b/i,
    constraint:
      "You must emit a non-empty final answer. Reply with only the requested value (workspace-relative path or number) — no quotes, explanation, or extra text. For path questions, give the file that DEFINES the symbol (e.g. lib/tax.py), not an import site. After tools return, state that value immediately.",
  },
  {
    id: "test-verify",
    test:
      /\b(run|confirm).{0,50}\b(test\.mjs|test\.py|tests?|dotnet\s+run)\b.{0,40}\b(pass|succeed|ok)\b|\b(test\.mjs|test\.py|dotnet\s+run)\b.{0,40}\b(run|pass|confirm)\b/i,
    constraint:
      "Run the test/verify command with run_command (e.g. node test.mjs, python test.py, or dotnet run) as your last tool step, then state the pass/fail output in your final answer. Do not claim success if the exit code is non-zero, or if a CLI that should print records exited 0 with empty stdout or []. Once it passes (exit 0 with the expected output), finish immediately — no further exploratory commands.",
  },
  {
    id: "cli-module",
    test:
      /\b(create|write|implement)\b.{0,80}\b(\.mjs|cli)\b|\bnode\s+[\w./-]+\.mjs\b.{0,40}\b(--|\bprints?\b)/i,
    constraint:
      ".mjs is ESM (import/export only). If the script exports helpers and also runs as a CLI, guard entry-point code with import.meta.url === pathToFileURL(process.argv[1]).href so tests can import safely — never new URL(process.argv[1]) or URL.pathname (wrong on Windows). Prefer tests that spawn the CLI with fileURLToPath(new URL('./cli.mjs', import.meta.url)), never pathToFileURL(...).pathname. Validate required args and wrap file I/O in try/catch with a user-facing error and non-zero exit. Write the implementation before running tests.",
  },
  {
    id: "csharp-json",
    test:
      /\bdotnet\b[\s\S]{0,400}\bJSON array\b|\bJSON array\b[\s\S]{0,400}\bdotnet\b|\bJsonSerializer\b|\bJsonNamingPolicy\b/i,
    constraint:
      "Read the input JSON file before writing C# models. Deserialize with JsonSerializerOptions { PropertyNameCaseInsensitive = true } (JSON keys are camelCase; C# properties are PascalCase). Serialize with PropertyNamingPolicy = JsonNamingPolicy.CamelCase. After dotnet run, read stdout: exit 0 with [] or empty output is a failure if records were expected. For new console apps, use a Program class with static void Main(string[] args) instead of mixing top-level statements with type declarations (CS8803). If you keep top-level statements, they must come before any type or namespace, and never declare a local `args` (CS0136 shadows implicit Main args — use `cliArgs`). Never use `out` variables inside `||`/`&&` (CS0165) — assign TryParse to a bool, then test it.",
  },
  {
    id: "python-import",
    test:
      /\b(greet|slugify|filter)\.py\b|[\s\S]{0,80}\bfrom\s+\w+\s+import\s+\w+|\bpython3?\s+test\.py\b/i,
    constraint:
      "If Foo.py defines foo(), tests and callers must `from foo import foo` (or `import foo as foo_mod`). `import foo` then foo() calls the module and raises TypeError. Do not add optional CLI modes the goal did not name. Omit unused imports. For JSON flags, test the boolean strictly (`active is True` / `=== true`), not truthiness.",
  },
  {
    id: "python-json",
    test:
      /\bpython3?\s+[\w./-]+\.py\b[\s\S]{0,200}--|\bpython3?\b[\s\S]{0,300}\bJSON array\b/i,
    constraint:
      "Read the JSON fixture before writing code. Implement only flags the goal names — do not add extra modes or a no-flag dump path unless asked. Filter flag fields with a strict boolean check (`active is True`), not truthiness. Omit unused imports. If the module is also imported, guard CLI with if __name__ == '__main__'. After python test.py passes, run the named python ... --flag command once; exit 0 with [] or empty stdout is a failure. Then finish — do not re-run extra CLI probes.",
  },
  {
    id: "csharp-cli",
    test:
      /\bcatalog\.json\b[\s\S]{0,1200}\bdotnet\s+run|\bdotnet\s+run\s+--[\s\S]{0,800}\b(list|find|low\s+--threshold|category)\b/i,
    constraint:
      "After implementing the CLI, smoke-test each named subcommand with run_command (list, find, total, low, category, and one unknown command) — do not stop after only `dotnet build` or `dotnet run -- list`. Unknown commands should exit non-zero. Deserialize JSON with PropertyNameCaseInsensitive = true. Exit 0 with qty=0 / missing SKUs is a failure — fix binding and re-run. `low --threshold n` is inclusive (qty <= n, not < n); smoke-test a threshold equal to an item's qty and confirm that SKU is printed. Prefer `static void Main(string[] args)` over top-level statements; never declare a local `args` (CS0136). Split `int.TryParse(...)` out of `||`/`&&` into its own statement (CS0165). After the first compile error, apply the canonical fix for that CS code once — do not loop on cosmetic renames; cap retries at 2 per distinct error code.",
  },
  {
    id: "csharp-tests",
    test: /\bdotnet\s+test\b|\b(xunit|nunit|mstest)\b|\bseparate test project\b/i,
    constraint:
      "Create a real test project (dotnet new xunit or equivalent), not asserts in Program.cs. After the app compiles, run `dotnet test` from the workspace root and only claim success if it exits 0. If the CLI is not the only project, invoke it with `dotnet run --project <csproj> -- <args>`. Persist CLI state to the named file so later commands see earlier adds. Locate the workspace via `.sln`, `.slnx`, or the known csproj — `dotnet new sln` may write `.slnx`, so do not hardcode a single solution filename. In C#, do not name a method the same as its class (CS0542). Validation tests must call shared app validation or spawn the CLI — do not duplicate CLI rules in a local test helper.",
  },
  {
    id: "follow-up",
    test:
      /\bthis is a new request\b|\balready contains a working\b|\bdo not rewrite(?: the project)? from scratch\b/i,
    constraint:
      "This is mandatory new work on an existing project. Read the current source, implement every newly named command with edit_file (prefer patch over rewrite), then smoke-test original plus new commands. Passing `dotnet build` or existing commands is not completion. Do not stop with 'no files were edited'. Before changing test assertions, trace state against the spec — if the implementation already matches, keep it and fix the test.",
  },
  {
    id: "greenfield-scaffold",
    test: isGreenfieldScaffoldGoal,
    constraint:
      "This is a from-scratch project. Create the real app files yourself with write_file (manifest + entry/source files, e.g. package.json, main process, renderer HTML) and run installs/builds with run_command. Do not write a setup/install script as a substitute — you must perform each step. 'Shell of an app' means the skeleton, not a shell script. For npm/yarn/pnpm install of large packages (electron), omit timeout_seconds or set it to at least 180.",
  },
  {
    id: "shell-script",
    test:
      /\b(bash|shell|powershell)\s+scripts?\b|\bscripts?\.(sh|ps1|bash)\b|\b(create|write|make)\b.{0,50}\b(a\s+)?scripts?\b(?!\s*\.(mjs|js|ts|py|cs))/i,
    constraint:
      "On Windows, new shell scripts must be PowerShell (.ps1), not bash/.sh, unless the user asked for bash. Run them with run_command using PowerShell syntax (chain with ';'). On POSIX, write .sh and use POSIX sh syntax. If the user asked for an app/project shell (skeleton), that is not a shell script — write the app files instead.",
  },
  {
    id: "smoke-cli",
    test: /\bsmoke-test\b/i,
    constraint:
      "Before finishing, run each named smoke-test command with run_command. On Windows PowerShell chain with ';' not '&&'. After a command exits 0, do not re-run that same command; `dotnet build` is separate from `dotnet run` smoke tests. Treat verificationComplete:true as terminal success and give the final answer.",
  },
  {
    id: "build-from-source",
    test:
      /\b(?:from source|compile|compcert|\.\/configure|make\s+install|apt-?get\s+install|wget\s+https?:)\b/i,
    constraint:
      "This is a multi-step build. Prefer run_command with curl/wget over fetch_url for archives. When the instruction names a specific source channel (e.g. Debian packages, apt), use that channel via shell tools — do not switch to alternate mirrors because fetch_url returned 503. System paths (/etc/apt, /usr/local/bin) must be changed with run_command (tee, apt, install), not write_file. Checklist: locate source → download → extract → compile → install → run every acceptance command named in the instruction (exit 0 + expected output shape). After installing build-essential or similar, re-run the last failed compile/make step before exploring new strategies. After 2–3 HTTP 404/empty-search failures, switch approach within the required channel. Environment probes are not completion.",
  },
  {
    id: "artifact-create",
    test:
      /\b(?:titled|named|called|output (?:fasta )?file|save as|write (?:to|into))\b.{0,80}\b[\w./-]+\.[A-Za-z0-9]+\b|\b[\w.-]+\.(fasta|fa|csv|json|txt)\b.{0,40}\b(?:output|create|write|save)\b/i,
    constraint:
      "The instruction names an output artifact. Create it with write_file (or an explicit redirect to that path) before any stop condition. Exit 0 alone does not mean the task is done unless the required output artifact exists. If no files were changed, keep working or report failure — do not stop. Workspace paths are relative to the root: if the root is /app, write_file 'filter.py' not 'app/filter.py' or '/app/filter.py' (those create /app/app/filter.py). After the file exists, run the instruction's behavioral verification (simulation, CLI, or named test) and confirm stdout matches — file-exists is not completion when output values are specified.",
  },
  {
    id: "computation-deliverable",
    test:
      /\b(simulat|comput|generat|fibonacci|circuit|intractable|must print|should print|prints?\s+(?:the\s+)?(?:value|result|output)|expected (?:output|value))\b/i,
    constraint:
      "This is a computation/simulation task — an empty or stub output file is not done. If brute force looks intractable, pivot: write_file a short generator script, then run_command it (do not inline thousands of lines in write_file). 'Create file then finish' is invalid; require a verification run whose stdout matches the instruction before stopping.",
  },
  {
    id: "html-sanitize",
    test: /\b(filter.?js|sanitiz|xss|script tag|onerror|innerHTML|strip javascript|remove javascript|html filter)\b/i,
    constraint:
      "For HTML/JS sanitization, do not rely on regex-only stripping. Prefer a real parser (BeautifulSoup, lxml, html.parser) plus an attribute/URL allowlist. Enumerate common XSS bypasses before finishing: entity encoding, event handlers without a space (onclick=), data:/vbscript:/javascript: URLs, CSS expression(), SVG/embed/math, and `on\\w+` that must match attribute names not arbitrary 'on' substrings. Keep a clean-HTML regression fixture and re-run it after each change.",
  },
  {
    id: "dna-primer",
    test: /\b(sequences\.fasta|oligotm|primer|dna.?insert|insertion site|melting temperature|Tm)\b/i,
    constraint:
      "Read sequences.fasta first, identify the insertion/mutation region, design primers for that site, then validate Tm with oligotm using the exact flags named in the instruction before finishing. Do not guess primer sequences without reading the input FASTA.",
  },
  {
    id: "rpc-proto",
    test: /\b(grpc|protobuf|\.proto|rpc\b|protocol buffers?)\b/i,
    constraint:
      "When the instruction describes RPC/message fields in English (e.g. 'a value (int)'), use that exact identifier as the proto field name unless a different name is quoted. Do not silently shorten value to val or similar synonyms. After starting a server, verify with a short RPC/TCP check, not only a possibly-buffered log.",
  },
  {
    id: "numeric-artifact",
    test: /\b(raman|peak fit|eigenval|curve_fit|wavenumber|gamma)\b|\bresults\.json\b.{0,120}\b(fit|peak|param)/i,
    constraint:
      "For numeric artifacts, exit 0 plus file-exists is not enough. Sanity-check values against stated domain ranges (e.g. graphene G≈1580 cm⁻¹, 2D≈2700, narrow gamma) before finishing. Huge gamma, negative multi-million offsets, or hard-coded zeros mean the fit is wrong — tighten bounds and retry rather than deleting required parameters.",
  },
  {
    id: "polyglot",
    test: /\bpolyglot\b|\bmain\.rs\b.{0,120}\b(?:rustc|g\+\+|c\+\+)\b/i,
    constraint:
      "Mandatory first actions: run_command mkdir -p polyglot (or the named directory), then write_file the named main source (e.g. polyglot/main.rs) with a minimal scaffold. Internal thinking/reasoning does not create files — the first model turn after planning must call write_file or run_command, not an empty response.",
  },
  {
    id: "pinned-package",
    test: /\b(must use|use the|revision|sentence.?transformers|mteb|huggingface|pystan|rstan|pymc)\b|\bpip install\s+[\w.-]+==/i,
    constraint:
      "The instruction names a required package, version, or revision. Before writing integration code, verify its API with web_search/fetch_url or run_command (import + help/dir) — do not guess method names from memory. Import that exact package first and print its version with run_command before substituting alternates. Put outputs at the instruction paths.",
  },
  {
    id: "install-and-run",
    test: /\b(install|pip install|apt[- ]?get install)\b[\s\S]{0,300}\b(run|execute|python3?\s+|node\s+)/i,
    constraint:
      "The instruction requires install then run. Both need successful run_command calls before finishing — install/compile alone is not completion. After install, run the named script or command and confirm exit 0 plus expected output.",
  },
  {
    id: "lookup-and-write",
    test:
      /\b(mteb|leaderboard)\b|\blookup\b.{0,40}\bwrite\b|\b(write|save).{0,60}\b[\w./-]+\.(json|txt|csv)\b/i,
    constraint:
      "Lookup-and-write plan: (1) acquire data once (curl/API or web_search then fetch_url), (2) compute/filter the answer, (3) write_file the required output path, (4) read_file or test -f to verify. Do not declare done while describing remaining work. After 4 exploratory commands (pip show, import probes) without write_file, stop introspecting and write_file a short script + run_command it.",
  },
  {
    id: "reverse-engineer",
    test: /\b(reverse.?engineer|objdump|readelf|decompile|mystery binary|path.?tracing|\belf\b|feal|linear.?cryptanalysis|cryptanalysis)\b/i,
    constraint:
      "Start with objdump/readelf/strings/nm on the given binary, or read the named cipher sources (e.g. feal.c, decrypt.c) and sample pairs.txt before implementing any attack. Do not finish by cat'ing an existing output image. Compile your reconstruction to a new name so you do not overwrite the task-provided binary. Independence from files produced by running the mystery binary is required when the instruction says so.",
  },
  {
    id: "secret-sanitize",
    test: /\b(sanitiz\w*.{0,60}secrets?|remov\w*.{0,40}(secrets?|credential|api.?key|token)|AKIA|ghp_|hf_|leaked?\s+secrets?)\b/i,
    constraint:
      "Search for literal secret patterns (AKIA*, ghp_*, hf_*) and assignment values after '=', not only env var names. edit_file or write_file every hit, then grep_search again to prove secrets are gone before finishing. Do not claim files changed if no write/edit succeeded.",
  },
  {
    id: "optimize-threshold",
    test: /\b(optimiz\w*|maximi[sz]e|minimi[sz]e|batching.?schedul|shape.?packer|baseline.?packer|cost.?model|inference.?batch)\b|\bmeet(?:s|ing)?\s+(?:a\s+)?threshold\b|\bpass(?:es|ing)?\s+(?:the\s+)?threshold\b/i,
    constraint:
      "Measure against the stated metric and iterate until the threshold passes or the step budget ends. Helper/baseline scripts are not completion — they may overwrite output_data; after any baseline that clobbers outputs, re-run your packer/solver. Prefer edit_file + an alternate command (python3 -c …) over repeating the same blocked find_files/run_command loop.",
  },
  {
    id: "script-smoke",
    test: /\b(write|create|implement|fix)\b.{0,80}\b[\w./-]+\.py\b|\bpython3?\s+[\w./-]+\.py\b/i,
    constraint:
      "Before finishing a Python script deliverable: run python -m py_compile on the file, then at least one run with the instruction's demo paths when available. Refuse to mark done if the file fails to parse. After the last write/edit, read_file the deliverable and ensure your final answer matches on-disk contents.",
  },
  {
    id: "pytorch-ml",
    test:
      /\b(torch|pytorch|pipeline.?parallel|distributed.?train|train_step\w*|tensor|nn\.Module)\b/i,
    constraint:
      "ML/PyTorch task: read_file tests under /tests (or test_*.py) and any caller before your first implementation. Token IDs and label indices stay integer (torch.long); only activations/hidden states/gradients use the passed float dtype. py_compile is syntax-only — run pytest on /tests (or python -m pytest tests) before finishing. Avoid module-level print() that runs on import. In Docker /app workspaces, uv/pytest may be available; if deps are heavy, try a minimal `python -c` import smoke with fake tensors, but still run pytest when /tests exists.",
  },
  {
    id: "pytorch-model-cli",
    test: (text) => /\bweights\.json\b/i.test(text) && /\bcli_tool\b/i.test(text),
    constraint:
      "Export weights as real JSON (json.dump / converted state dict), never cp/mv a binary checkpoint to weights.json. After write_file weights.json, validate with python -c \"import json; json.load(open('weights.json'))\". Before finishing, run_command ./cli_tool weights.json <image.png> (or the instruction's exact paths) and confirm exit 0 with a single-digit prediction on stdout. If python fails with ModuleNotFoundError: torch, pip install torch in the workspace first.",
  },
  {
    id: "sqlite-carve",
    test: /\b(sqlite|truncate[d]? (?:db|database)|recover\.json)\b/i,
    constraint:
      "If the SQLite header magic is missing or .recover fails, carve leaf-page records from serial types instead of guessing fields from string suffixes. After dumping record bytes next to carved keys, parse and validate before writing the deliverable — do not invent correlated columns when only one field is visible as text.",
  },
  {
    id: "http-server",
    test: /\b(http|server\.mjs|listens?\s+on\s+port|PORT\s+env)\b|\/health|\/echo/i,
    constraint:
      "If tests import an exported handler and create their own server, add only the requested route — do not add import.meta.url listen/bootstrap or formatting-only edits. If the task says the file listens when run as node server.mjs, include that main check. After documenting a run command in README.md, run that exact command once. Do not start a long-running server in the foreground after tests already passed. For outbound HTTP in tests, use `import { request } from 'node:http'` (or fetch against a listening server) — `createServer()` returns a server, not a request factory.",
  },
  {
    id: "extract-shared",
    test: /\b(extract|shared|refactor).{0,60}\b(module|util|slugify|common)\b|\binto\s+(?:a\s+)?shared\b/i,
    constraint:
      "Write the shared module file first, then update importers to use it, then run tests — avoid a broken import window. In C#, do not name a method the same as its enclosing class (CS0542); keep the class/file name (e.g. Slugify) and rename the method (e.g. ToSlug). JSON printed from C# CLIs should use camelCase (JsonNamingPolicy.CamelCase) and deserialize with PropertyNameCaseInsensitive = true.",
  },
  {
    id: "fixture-first",
    test: /\b(sample\.txt|fixture|\.csv|\.log|data\/[\w./-]+)\b.{0,80}\b(create|write|implement|count|summar)/i,
    constraint:
      "Read the named sample/fixture file before writing the implementation so formats and edge cases match reality.",
  },
  {
    id: "error-handling",
    test: /\b(error handling|graceful|missing (?:file|subcommand)|unknown (?:command|subcommand)|exit(?:s)? non-zero)\b/i,
    constraint:
      "Include at least one negative-path check (missing args/file or unknown subcommand) via a test assertion or a one-off run_command before finishing. Validate required args; wrap file I/O in try/catch with a user-facing error and non-zero exit rather than letting the process throw.",
  },
  {
    id: "config-edit",
    test: /\b(config\.json|\.json)\b.{0,40}\b(change|edit|update|set|flip|modify)\b|\bchange\b.{0,40}\b(debug|true|false)\b/i,
    constraint:
      "read_file the config first, edit_file the exact key, then read_file again to verify before finishing.",
  },
  {
    id: "refactor",
    test: /\b(refactor|rename|extract|move|reorganiz)\w*/i,
    constraint:
      "Read every affected file first. Make one logical change at a time and verify after each. For renames, update all sites before the verify run.",
  },
  {
    id: "implement",
    test: /\b(implement|add|create|build|write)\b.{0,40}\b(feature|function|class|module|component|endpoint|api)\b/i,
    constraint:
      "If the workspace already has similar code, grep_search and match its patterns before writing new code. If it is empty, write the new files with write_file — do not search first and do not write a setup script instead.",
  },
  {
    id: "explain",
    test: /\b(explain|describe|how does|what does|walk me through)\b/i,
    constraint:
      "Read the relevant source files before answering. Cite specific file paths in your answer.",
  },
  {
    id: "multi-step",
    test: /\b(?:and then|after that|also|next|finally)\b/i,
    constraint: "This is a multi-step task — complete each step in order and verify before moving on.",
  },
];

/**
 * Export task hint rules for memory seeding.
 * @returns {Array<{id: string, constraint: string}>}
 */
export function exportTaskHintSeedRules() {
  return TASK_HINT_RULES.map((r) => ({ id: r.id, constraint: r.constraint }));
}

export const PLANNING_USER_MESSAGE = [
  "Before using any tools, write a short Goals section first: 2–5 bullet outcomes",
  "that define done (named deliverables, exit-0 commands, final-answer shape).",
  "If the user message already includes ## Goals, keep those and add any missing",
  "acceptance criteria you infer from the task.",
  "Then write a short numbered plan (3–6 steps) for the task above.",
  "Name the specific tools you will use (read_file, grep_search, run_command, etc.).",
  "If the task needs no tools, the plan is one line: 'No tools — answer directly.'",
  "Before the first edit, plan to read the target file and any existing tests that define the expected interface (flag names, signatures, output format).",
  "For fix/debug tasks use: reproduce (run failing command) → diagnose → fix all related sites in one change → verify.",
  "If a replace_all or an ambiguous edit would touch more than one function, re-read the file and plan one unique per-function edit — do not ping-pong a shared statement.",
  "For create/CLI/server tasks include a final verify step that runs every named command and the tests; do not plan to claim success without that run. Chain smoke commands in one run_command when the task lists several.",
  "For build-from-source tasks, plan curl/wget download (not fetch_url), extract, compile, install, then the instruction’s sanity command. After 2–3 404s switch mirrors.",
  "For pinned-package tasks, plan run_command that imports the named package and prints its version before any encoding/work.",
  "For reverse-engineering, plan objdump/readelf/strings first; for FEAL/crypto, plan reading feal.c/decrypt.c and sampling pairs.txt before any attack code. Compile to a new binary name. For truncated SQLite, plan page carving, not suffix guessing.",
  "For secret-sanitize tasks, plan grep for AKIA/ghp/hf literals and '=' assignments, then edit, then re-grep to prove secrets are gone.",
  "For threshold/optimization tasks, plan measure → iterate until threshold; re-run solvers after any baseline that overwrites outputs.",
  "For Python script deliverables, plan py_compile plus a demo-path run before the final answer.",
  "For artifact-creation tasks, name the output path and plan write_file of that file before finishing. Exit 0 is not done if the named file is missing. Paths are workspace-relative: if the root is /app, write filter.py not app/filter.py.",
  "For computation/simulation tasks, plan a generator script + run_command when inline content would be huge; block placeholder stubs. Plan a final verify step with named stdout checks.",
  "For HTML/JS sanitization tasks, plan a parser + allowlist (not regex-only) and a clean-HTML regression fixture covering XSS bypass classes.",
  "For gRPC/protobuf tasks, use the instruction's exact field names in the .proto; after starting a server, plan a short RPC/TCP check.",
  "For numeric fitting/artifact tasks, plan a domain-range sanity check of written values before claiming success.",
  "Harbor / Terminal-Bench goals: verify the instruction's deliverables (named files, named binaries), not workspace-relative test.mjs unless the instruction names it.",
  "For git merge/conflict tasks, plan repo/branches/merge first, then resolve CONFLICT with edit_file, commit, then verify — do not speculate at length on examples before the repo exists. Do not stop after only inspecting both sides.",
  "For follow-up / 'new request' tasks, map each new command to a planned file edit before any verify run — existing build/list success is not done.",
  "Implement only what the task asks: no extra entrypoints, listeners, or formatting-only edits. Name deliverable files before the first write_file.",
  "For empty-workspace / 'app shell' tasks, plan write_file of the real source files then run_command the install — never a setup/install script as the deliverable.",
  "End the plan at that verify step — once every named check passes, give the final answer with no extra exploratory commands.",
  "After tool results return, synthesize findings into a non-empty final answer — never end on an empty message. For path questions, reply with only the defining file's relative path.",
  "If a compile fails, classify the CS error (CS0136 args shadowing vs CS0165 definite assignment vs CS0542) and apply the canonical fix once; cap retries at 2 per distinct error code.",
  "Do not call tools yet — reply with only the plan.",
  "After the plan, include a ## Acceptance section with bullet checks: deliverable: <path>, command: <exact shell command>, output: <final answer shape>.",
  "Name only checks you will actually run — the loop blocks completion until they pass.",
  "Goals, the plan, and ## Acceptance are for this planning turn only — later final answers must omit them.",
].join(" ");

/** Tools that ground answers or change workspace state. */
export const SUBSTANTIVE_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "grep_search",
  "find_files",
  "run_command",
  "search_project",
]);

export const MUTATING_TOOL_NAMES = new Set(["write_file", "edit_file"]);

export const TOOL_NUDGE_NO_TOOLS = [
  "You replied without calling any tools, but this task requires tool use.",
  "Call the appropriate tools now (read_file, grep_search, write_file, edit_file, run_command, etc.)",
  "to complete the work before giving your final answer.",
].join(" ");

export const TOOL_NUDGE_EMPTY_RESPONSE = [
  "Your last response had no tool calls and no final answer.",
  "For artifact-creation tasks, internal thinking alone does not write files or run commands.",
  "Call write_file or run_command now — do not send another empty turn.",
].join(" ");

export const TOOL_NUDGE_FIRST_TOOL_ACTION = [
  "This task requires creating or changing files on disk.",
  "Thinking/reasoning alone never satisfies artifact-creation — your next response MUST be a tool call",
  "(write_file or run_command), not another empty assistant turn.",
].join(" ");

export const TOOL_NUDGE_POLYGLOT_BOOTSTRAP = [
  "Bootstrap now — do not reason further without tools:",
  "1) run_command: mkdir -p polyglot",
  "2) write_file polyglot/main.rs with a minimal Fibonacci scaffold (you can refine after).",
  "Then verify with the instruction's rustc and g++ commands.",
].join(" ");

export const TOOL_NUDGE_EMPTY_ANSWER = [
  "Your answer was empty. Use tools to gather information or make the required changes,",
  "then reply in plain text with your final answer.",
].join(" ");

export const TOOL_NUDGE_EMPTY_AFTER_TOOLS = [
  "Your answer was empty. The user needs a non-empty final reply.",
  "Synthesize what you learned from the tool results into a plain-text answer now.",
  "Do not call more tools unless a required verification command has not yet succeeded.",
].join(" ");

export const TOOL_NUDGE_EMPTY_VALUE = [
  "Your answer was empty. Reply now with only the requested value",
  "(workspace-relative path or number) — no quotes, explanation, or extra text.",
  "For path questions, give the file that DEFINES the symbol, not an import site.",
  "Do not call more tools.",
].join(" ");

export const TOOL_NUDGE_NEAR_LIMIT = [
  "You are on your last tool step.",
  "If you already diagnosed a compile or test failure, apply that exact fix now.",
  "Then give a non-empty final answer. Do not explore or re-run passing commands.",
].join(" ");

export const TOOL_NUDGE_VERIFY = [
  "Do not finish yet — run the verification command(s) the task requires with run_command",
  "(e.g. node test.mjs, python test.py, or dotnet run, plus any named CLI invocation) and only claim success if the exit code is 0.",
].join(" ");

export const TOOL_NUDGE_PRETEST = [
  "This task requires reproducing failing tests before edits.",
  "Call run_command with the test command first, then fix, then re-run.",
].join(" ");

export const TOOL_NUDGE_ALREADY_VERIFIED = [
  "Verification already succeeded (exit 0).",
  "verificationComplete: true",
  "Stop calling tools and give your final answer now.",
  "Do not re-run the same command, and do not run diagnostic commands like node -v.",
  "In the final answer, mention only files you changed and the command that exited 0 — never mention blocked diagnostics.",
].join(" ");

export const TOOL_NUDGE_DIAGNOSTIC_BLOCKED = [
  "status: blocked",
  "That command is an environment probe or generic diagnostic, not task verification.",
  "Do not treat exit 0 from apt-get --version, apt-cache, diff, awk, head, or similar as completion.",
  "Run the next real build/install/write step, or give the final answer if every named deliverable already exists.",
].join(" ");

export const TOOL_NUDGE_DELIVERABLE = [
  "Do not finish yet — the instruction names an output file that has not been created.",
  "write_file (or otherwise create) that path, then confirm it exists.",
  "Exit 0 alone does not mean the task is done unless the required output artifact exists.",
].join(" ");

export const TOOL_NUDGE_DELIVERABLE_VERIFY = [
  "The output file exists, but that alone is not completion when the instruction defines behavioral output.",
  "Re-read the original goal and run the named verification command (simulation, CLI, or test)",
  "with run_command; confirm stdout matches the expected values before stopping.",
  "Empty or stub file contents do not satisfy a computation/simulation task.",
].join(" ");

export const TOOL_NUDGE_MERGE_CONFLICT = [
  "Do not finish yet — a merge CONFLICT is still unresolved.",
  "Required loop: edit_file or write_file to remove <<<<<<< markers,",
  "then git add and git commit, then run the named verification (e.g. examples.json).",
  "Inspecting both sides with git show is not completion.",
].join(" ");

export const TOOL_NUDGE_FOLLOW_UP = [
  "This is a new request on an existing project.",
  "Do not stop because build or existing commands still pass.",
  "Edit the existing source to implement every newly named command,",
  "then smoke-test original plus new commands.",
].join(" ");

export const TOOL_NUDGE_SCAFFOLD = [
  "Do not finish yet. A setup/install script is not the project.",
  "write_file the actual app files (package.json, main process, HTML/renderer, or the named sources),",
  "then run_command the install yourself. 'App shell' means the skeleton, not a shell script.",
].join(" ");

export const TOOL_NUDGE_FIX_IMPL = [
  "Tests failed as the task predicted.",
  "Read the implementation file, fix only the broken logic with edit_file or write_file",
  "(no extra validation, docstrings, or features), then re-run the tests.",
].join(" ");

export const TOOL_NUDGE_READ_IMPL = [
  "The first test run already exited 0.",
  "Read the named implementation file (not only the tests) and compare it to the assertions.",
  "If it is already correct, stop and say so. Do not add validation, docstrings, or extra features.",
].join(" ");

export const TOOL_NUDGE_AMBIGUOUS_EDIT = [
  "That edit_file was ambiguous or changed more than one function.",
  "read_file the current file now, then plan one unique edit per function",
  "using enclosing def/class context (for example old_string: def mul(a, b):\\n    return a + b).",
  "Omit replace_all unless you are renaming a single identifier everywhere.",
  "Do not flip the same global snippet back and forth.",
].join(" ");

export const TOOL_NUDGE_EDIT_MISS_REWRITE = [
  "edit_file old_string missed twice on this file.",
  "Stop guessing escapes. read_file the current file, then use write_file for a full rewrite,",
  "or copy an exact nearby snippet from the tool error (including whitespace) as old_string.",
].join(" ");

export const TOOL_NUDGE_SEARCH_LOOP = [
  "You are looping on the same find_files / blocked run_command pattern.",
  "Stop repeating. Prefer edit_file on the deliverable, or try an alternate command",
  "(e.g. python3 -c '…', touch then run, or a different script path).",
].join(" ");

export const TOOL_NUDGE_INTROSPECTION_LOOP = [
  "Too many exploratory commands without write_file.",
  "For lookup-and-write tasks: fetch/compute once, write_file the required output path,",
  "then verify — stop pip show / import probes and script the remaining steps.",
].join(" ");

export const TOOL_NUDGE_REMAINING_WORK = [
  "Your answer describes work still to do.",
  "write_file the required output path now, read_file to verify, then finish —",
  "do not stop with a plan or todo list.",
].join(" ");

export const TOOL_NUDGE_SECRET_HIT = [
  "grep_search found secret-like literals (AKIA / ghp_ / hf_ / assigned tokens),",
  "but no successful write_file or edit_file has run yet.",
  "edit_file those values out now, then re-grep to prove they are gone.",
].join(" ");

export const TOOL_NUDGE_CLAIM_NO_MUTATION = [
  "Do not claim file changes — the trajectory has no successful write_file or edit_file.",
  "Apply the edit now (or report failure). For sanitize tasks, require at least one",
  "edit after secret hits before stopping.",
].join(" ");

export const TOOL_NUDGE_DELIVERABLE_DRIFT = [
  "You wrote or edited the primary deliverable.",
  "Before the final answer, read_file that path and confirm your answer matches",
  "on-disk contents (no answer/disk drift).",
].join(" ");

/** Max consecutive empty assistant turns (no content, no tool calls) before hard fail. */
export const MAX_CONSECUTIVE_EMPTY_RESPONSES = 2;

/**
 * Assistant message with no tool calls and no public content.
 * @param {object} message
 * @returns {boolean}
 */
export function isEmptyAssistantResponse(message) {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length > 0) return false;
  return !String(typeof message?.content === "string" ? message.content : "").trim();
}

/**
 * Model returned only internal thinking with no tool calls or answer text.
 * @param {object} message
 * @returns {boolean}
 */
export function isThinkingOnlyResponse(message) {
  if (!isEmptyAssistantResponse(message)) return false;
  return String(message?.thinking ?? "").trim().length > 0;
}

/**
 * Nudge after an empty model turn. Polyglot / deliverable tasks get a concrete bootstrap.
 * @param {object} input
 * @param {string} input.goal
 * @param {Array<{toolCalls?: Array<object>}>} input.steps
 * @param {number} input.consecutiveEmpty
 * @returns {string|null}
 */
export function emptyResponseRecoveryNudge({ goal, steps, consecutiveEmpty }) {
  if (consecutiveEmpty < 1) return null;
  const bootstrap = firstTurnBootstrapNudge({ goal, steps });
  if (bootstrap) return bootstrap;
  if (
    (steps ?? []).length >= 6 &&
    detectTaskHints(goal).some((h) => h.id === "password-crack")
  ) {
    return [
      "Do not send another empty turn — you are deep into a crack/hash task.",
      "Next: build john from ./john/src if present, verify wordlist exists",
      "(wamerican or /usr/share/wordlists), run 7z2john.pl then john --wordlist=….",
      "After write_file of the deliverable, read_file and validate before finishing.",
    ].join(" ");
  }
  if (!goalNeedsSubstantiveTools(goal)) return null;
  return TOOL_NUDGE_FIRST_TOOL_ACTION;
}

/**
 * Concrete bootstrap when the first substantive turns produced no tool calls.
 * @param {object} input
 * @param {string} input.goal
 * @param {Array<{toolCalls?: Array<object>, kind?: string}>} input.steps
 * @returns {string|null}
 */
export function firstTurnBootstrapNudge({ goal, steps } = {}) {
  const calls = flattenToolCalls(steps);
  if (calls.length > 0) return null;
  const actionSteps = (steps ?? []).filter((s) => s.kind !== "plan");
  if (actionSteps.length > 2) return null;

  const text = String(goal ?? "");
  const hints = detectTaskHints(text);
  if (hints.some((h) => h.id === "polyglot") || /\bpolyglot\b/i.test(text)) {
    const dir =
      text.match(/\b([\w.-]+)\/main\.(?:rs|c|py|cpp)\b/i)?.[1] ??
      (/\bpolyglot\b/i.test(text) ? "polyglot" : null);
    const file =
      text.match(/\b([\w.-]+\/main\.(?:rs|c|py|cpp))\b/i)?.[1] ??
      (dir ? `${dir}/main.rs` : null);
    if (dir && file) {
      return [
        `Bootstrap now — do not reason further without tools:`,
        `1) run_command: mkdir -p ${dir}`,
        `2) write_file ${file} with a minimal scaffold (refine after).`,
        `Then run the instruction's compile/smoke commands.`,
      ].join(" ");
    }
    return TOOL_NUDGE_POLYGLOT_BOOTSTRAP;
  }

  const deliverables = extractNamedDeliverables(text).filter(isCreatedFileDeliverable);
  if (deliverables.length > 0 || hints.some((h) => h.id === "artifact-create" || h.id === "implement")) {
    if (deliverables[0]) {
      return [
        TOOL_NUDGE_FIRST_TOOL_ACTION,
        `Start with write_file ${deliverables[0]} (minimal stub is fine), then iterate.`,
      ].join(" ");
    }
    return TOOL_NUDGE_FIRST_TOOL_ACTION;
  }
  return null;
}

/**
 * Hard-fail when the model stalls on empty turns and required work is still missing.
 * @param {object} input
 * @param {string} input.goal
 * @param {Array<{toolCalls?: Array<object>}>} input.steps
 * @param {number} input.consecutiveEmpty
 * @returns {boolean}
 */
export function shouldFailOnEmptyResponses({ goal, steps, consecutiveEmpty }) {
  if (consecutiveEmpty < MAX_CONSECUTIVE_EMPTY_RESPONSES) return false;
  if (!goalNeedsSubstantiveTools(goal)) return false;
  const calls = flattenToolCalls(steps);
  if (substantiveToolsUsed(steps).size > 0 && missingRequiredVerification(goal, calls).length === 0) {
    return false;
  }
  return true;
}

/**
 * Human-readable note when Ollama returned zero completion tokens for a long run.
 * @param {object} input
 * @param {number} input.totalEvalCount
 * @param {number} input.elapsedMs
 * @param {string} [input.model]
 * @param {string} [input.baseUrl]
 * @returns {string|null}
 */
export function formatZeroTokenDiagnostic({
  totalEvalCount,
  elapsedMs,
  model,
  baseUrl,
} = {}) {
  if (totalEvalCount > 0) return null;
  if (elapsedMs < 30_000) return null;
  const modelLabel = model ? `model '${model}'` : "the model";
  const host = baseUrl ? ` via ${baseUrl}` : "";
  return (
    `Ollama returned 0 completion tokens (${modelLabel}${host}) after ${Math.round(elapsedMs / 1000)}s. ` +
    "The backend may have returned malformed or thinking-only completions — check routing, context size, and tool-call support."
  );
}

/**
 * After an ambiguous edit_file (or a non-identifier replace_all that hit
 * multiple sites), force a re-read and per-function plan so the model
 * does not ping-pong global replacements.
 * @param {{ steps?: Array<{ toolCalls?: Array<object> }> }} input
 * @returns {string|null}
 */
export function ambiguousEditRecoveryNudge({ steps } = {}) {
  const last = steps?.[steps.length - 1];
  const calls = last?.toolCalls ?? [];
  const failedAmbiguous = calls.some((c) => {
    if (c.name !== "edit_file" || c.ok) return false;
    return /appears \d+ times|replace_all is for identifier|enclosing function/i.test(
      String(c.error ?? ""),
    );
  });
  if (failedAmbiguous) return TOOL_NUDGE_AMBIGUOUS_EDIT;

  const multiReplace = calls.some((c) => {
    if (c.name !== "edit_file" || !c.ok) return false;
    const n = Number(c.result?.replacements ?? 0);
    const old = String(c.args?.old_string ?? "").trim();
    if (/^[\w.]+$/.test(old)) return false;
    return n > 1;
  });
  return multiReplace ? TOOL_NUDGE_AMBIGUOUS_EDIT : null;
}

/**
 * After two consecutive old_string misses on the same path, force a rewrite.
 * @param {{ steps?: Array<{ toolCalls?: Array<object> }> }} input
 * @returns {string|null}
 */
export function repeatedEditMissNudge({ steps } = {}) {
  const calls = flattenToolCalls(steps).filter((c) => c.name === "edit_file");
  if (calls.length < 2) return null;
  const last = calls[calls.length - 1];
  const prev = calls[calls.length - 2];
  const missed = (c) =>
    !c.ok && /not found|truncated|incomplete|not unique|appears \d+ times/i.test(String(c.error ?? ""));
  if (!missed(last) || !missed(prev)) return null;
  const a = String(last.args?.path ?? "");
  const b = String(prev.args?.path ?? "");
  if (a && a === b) return TOOL_NUDGE_EDIT_MISS_REWRITE;
  return null;
}

const SECRET_LITERAL_RE = /\b(AKIA[0-9A-Z]{8,}|ghp_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,})\b|=\s*['\"]?[A-Za-z0-9\/+=]{20,}/;

/**
 * When grep hits secret-like literals but no edit has been issued.
 * @param {{ goal?: string, steps?: Array<{ toolCalls?: Array<object> }> }} input
 * @returns {string|null}
 */
export function secretHitWithoutEditNudge({ goal, steps } = {}) {
  const hints = detectTaskHints(goal);
  const secretGoal =
    hints.some((h) => h.id === "secret-sanitize") ||
    /\b(sanitiz\w*|secrets?|credential|AKIA|ghp_|hf_)\b/i.test(String(goal ?? ""));
  if (!secretGoal) return null;
  const calls = flattenToolCalls(steps);
  if (hasSuccessfulMutation(calls)) return null;
  const hit = calls.some((c) => {
    if (c.name !== "grep_search" || !c.ok) return false;
    return SECRET_LITERAL_RE.test(callResultText(c));
  });
  return hit ? TOOL_NUDGE_SECRET_HIT : null;
}

/**
 * Detect loops of identical find_files / blocked run_command.
 * @param {{ steps?: Array<{ toolCalls?: Array<object> }> }} input
 * @returns {string|null}
 */
export function repeatedSearchLoopNudge({ steps } = {}) {
  const recent = (steps ?? []).slice(-3);
  if (recent.length < 3) return null;
  const keys = recent.map((s) => {
    const calls = s.toolCalls ?? [];
    return JSON.stringify(
      calls.map((c) => {
        const blocked =
          c.result?.status === "blocked" ||
          (!c.ok && /blocked|already exited/i.test(String(c.error ?? "")));
        return [c.name, c.args?.pattern ?? c.args?.command ?? c.args?.cmd ?? "", blocked];
      }),
    );
  });
  if (keys[0] && keys[0] === keys[1] && keys[1] === keys[2]) {
    const names = (recent[2].toolCalls ?? []).map((c) => c.name);
    if (names.some((n) => n === "find_files" || n === "run_command" || n === "grep_search")) {
      return TOOL_NUDGE_SEARCH_LOOP;
    }
  }
  return null;
}

/**
 * After write/edit of a primary deliverable, nudge a re-read before finish.
 * @param {{ goal?: string, steps?: Array<{ toolCalls?: Array<object> }> }} input
 * @returns {string|null}
 */
export function deliverableDriftNudge({ goal, steps } = {}) {
  const calls = flattenToolCalls(steps);
  if (!calls.length) return null;
  const last = calls[calls.length - 1];
  if (!last?.ok || !MUTATING_TOOL_NAMES.has(last.name)) return null;
  const deliverables = extractNamedDeliverables(goal).filter(isCreatedFileDeliverable);
  const hints = detectTaskHints(goal);
  if (!deliverables.length && !hints.some((h) => h.id === "script-smoke" || h.id === "artifact-create" || h.id === "artifact-only")) {
    return null;
  }
  const pathName = String(last.result?.path ?? last.args?.path ?? "");
  if (!pathName) return null;
  const alreadyRead = calls.some(
    (c, i) =>
      i > calls.length - 3 &&
      c.name === "read_file" &&
      c.ok &&
      String(c.args?.path ?? "").replace(/\\/g, "/").endsWith(pathName.replace(/\\/g, "/").split("/").pop()),
  );
  if (alreadyRead) return null;
  return TOOL_NUDGE_DELIVERABLE_DRIFT;
}

export const MUTATION_BLOCKED_PRETEST =
  "Blocked: this task mentions failing tests. Run the test command with run_command and inspect the failure before edit_file or write_file.";

const ACTION_GOAL =
  /\b(create|write|build|fix|edit|change|update|implement|modify|extract|refactor|rename|move|persist|include|merge|resolve)\b/i;
const RUN_TEST_GOAL = /\b(run|test)\b.{0,40}\b(node|npm|python|py|dotnet|test|spec|\.mjs|\.js|\.ts|\.py|\.cs)\b/i;
const ADD_FEATURE_GOAL = /\badd\b.{0,40}\b(cli|flag|route|feature|function|file|module|test|support)\b/i;
const READ_GOAL =
  /\b(read|open)\b.{0,40}\b(\.md|\.json|\.env|readme|config)\b/i;
const LOCATE_GOAL =
  /\b(which file|where is|find|locate|grep|search for|tell me|what port|what value|exports?)\b/i;
const SUCCESS_CLAIM =
  /\b(pass(?:es|ed)?|success|all tests? (?:pass|ok)|works|done|completed|fixed)\b/i;

/**
 * @param {string} goal
 * @returns {boolean}
 */
export function goalNeedsSubstantiveTools(goal) {
  const text = String(goal ?? "");
  return (
    ACTION_GOAL.test(text) ||
    RUN_TEST_GOAL.test(text) ||
    ADD_FEATURE_GOAL.test(text) ||
    READ_GOAL.test(text) ||
    LOCATE_GOAL.test(text)
  );
}

/**
 * @param {string} goal
 * @returns {boolean}
 */
export function isQuestionGoal(goal) {
  const text = String(goal ?? "");
  return /\?/.test(text) || /\b(what|which|where|how many|tell me)\b/i.test(text);
}

/**
 * Simple read-a-file-and-answer goals should not get a planning pre-pass.
 * @param {string} goal
 * @returns {boolean}
 */
export function isSimpleReadAnswerGoal(goal) {
  const text = String(goal ?? "").trim();
  if (ACTION_GOAL.test(text) || RUN_TEST_GOAL.test(text) || ADD_FEATURE_GOAL.test(text)) return false;
  return (
    /\b(read|open)\b.{0,50}\b(and answer|and tell)\b/i.test(text) ||
    (/\b(reply with|answer with)\b/i.test(text) && /\b(just|only)\b/i.test(text))
  );
}

/**
 * @param {Array<{toolCalls?: Array<{name: string, ok?: boolean}>}>} steps
 * @returns {Set<string>}
 */
export function substantiveToolsUsed(steps) {
  const used = new Set();
  for (const step of steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      if (call.ok && SUBSTANTIVE_TOOL_NAMES.has(call.name)) used.add(call.name);
    }
  }
  return used;
}

/**
 * @param {Array<{toolCalls?: Array<{ok?: boolean}>}>} steps
 * @returns {boolean}
 */
function anyToolCallsExecuted(steps) {
  return steps.some((step) => step.toolCalls?.some((call) => call.ok));
}

/**
 * Flatten tool calls from steps in order.
 * @param {Array<{toolCalls?: Array<object>}>} steps
 * @returns {Array<object>}
 */
export function flattenToolCalls(steps) {
  const out = [];
  for (const step of steps ?? []) {
    for (const call of step.toolCalls ?? []) out.push(call);
  }
  return out;
}

/**
 * @param {object} call
 * @returns {string}
 */
export function runCommandText(call) {
  if (call?.name !== "run_command") return "";
  const args = call.args ?? {};
  return String(args.command ?? args.cmd ?? "");
}

/**
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function hasRunCommand(calls) {
  return calls.some((c) => c.name === "run_command" && c.ok !== false);
}

/**
 * Read an exit code from a run_command result. Accepts both `exitCode` and
 * `exitCode`, plus a leading `status` of success/FAILED.
 * @param {unknown} result
 * @returns {number|null}
 */
export function commandExitCode(result) {
  if (result == null) return null;
  if (typeof result === "object") {
    const raw = result.exitCode ?? result.exitCode;
    if (raw != null && raw !== "") return Number(raw);
    const status = String(result.status ?? "");
    if (/^success$/i.test(status)) return 0;
    if (/FAILED|TIMED OUT/i.test(status)) return 1;
  }
  if (typeof result === "string") {
    const exitMatch = result.match(/exit(?:Code| code)\s*[:=]?\s*(-?\d+)/i);
    if (exitMatch) return Number(exitMatch[1]);
    if (/TIMED OUT|FAILED/i.test(result)) return 1;
    if (/^status:\s*success\b/im.test(result)) return 0;
  }
  return null;
}

/**
 * Test-suite runners. `dotnet run` is a CLI smoke, not a test suite.
 * @param {string} cmd
 * @returns {boolean}
 */
export function isTestSuiteCommand(cmd) {
  return /\b(test\.mjs|test\.py|npm\s+test|node\s+--test|dotnet\s+test|pytest|cargo\s+test|go\s+test|python3?\s+-m\s+(?:pytest|unittest))\b/i.test(
    String(cmd ?? ""),
  );
}

/**
 * @param {string} cmd
 * @returns {boolean}
 */
export function isTestCommand(cmd) {
  const text = String(cmd ?? "");
  if (isTestSuiteCommand(text)) return true;
  if (/\bdotnet\s+run\b/i.test(text)) return true;
  if (/\b(?:make\s+test|cargo\s+test|go\s+test)\b/i.test(text)) return true;
  return false;
}

/**
 * Structured tool result so a blocked duplicate of a *named* verification
 * command looks like terminal success, not a retriable error.
 * @param {string} [message]
 */
export function verificationCompleteOutcome(message = TOOL_NUDGE_ALREADY_VERIFIED) {
  return {
    ok: true,
    result: {
      status: "verification already succeeded",
      exitCode: 0,
      verificationComplete: true,
      stdout: "",
      stderr: "",
      note: message,
    },
  };
}

/**
 * A command that was not executed. Must not look like exit 0 success.
 * @param {string} command
 * @param {string} [message]
 */
export function blockedCommandOutcome(command, message) {
  return {
    ok: true,
    result: {
      status: "blocked",
      command: String(command ?? ""),
      stdout: "",
      stderr: "",
      note: message ?? "Command was not executed.",
    },
  };
}

export function isTerminalVerificationMessage(message) {
  const text = String(message ?? "");
  return text === TOOL_NUDGE_ALREADY_VERIFIED || /verificationComplete:\s*true/i.test(text);
}

/**
 * Environment probes and generic shell diagnostics. These must never latch
 * verificationComplete. Named verification commands from the goal override.
 * @param {string} cmd
 * @param {string} [goal]
 * @returns {boolean}
 */
export function isDiagnosticCommand(cmd, goal = "") {
  const text = String(cmd ?? "").trim();
  if (!text) return false;
  if (!looksLikeDiagnostic(text)) return false;
  if (isTaskNamedVerificationCommand(text, goal)) return false;
  return true;
}

function looksLikeDiagnostic(text) {
  if (/^(node|nodejs|python3?|py)(\s+(-v|--version|-V))?$/i.test(text)) return true;
  if (/^(uname|hostname|whoami|id|pwd|date|env|printenv)(\s|$)/i.test(text)) return true;
  if (/^(which|whereis|type|where)(\s|$)/i.test(text)) return true;
  if (/^apt-cache\b/i.test(text)) return true;
  if (/^apt(-get)?\s+(--version|-v|-V|policy)\b/i.test(text)) return true;
  if (/^(dpkg|rpm)\s+(--version|-v|-qa|-l)\b/i.test(text)) return true;
  if (/^(head|tail|awk|sed|cut|wc)\b/i.test(text)) return true;
  if (/^diff\b/i.test(text)) return true;
  if (/^ls\b/i.test(text)) return true;
  if (/^(file|stat)\s/i.test(text)) return true;
  if (/^(echo|printf)\b(?![\s\S]*[>&])/i.test(text)) return true;
  if (/^cat\b(?![\s\S]*[>&])/i.test(text)) return true;
  return false;
}

/**
 * `test -f` / `ls` of a named deliverable — still allowed after verification
 * when the output file has not been created yet.
 * @param {string} cmd
 * @returns {boolean}
 */
export function isExistenceCheckCommand(cmd) {
  return /\b(?:test\s+-[efd]|Test-Path|Get-Item|stat\s+|ls\s+)/i.test(String(cmd ?? ""));
}

const DATA_FILE_EXT = /\.(fasta|fa|txt|json|csv|out|md|xml|yml|yaml|html|tsv|ics)$/i;

const SOURCE_OR_TEST_EXT =
  /\.(mjs|js|ts|py|cs|sh|ps1|go|rs|c|cpp|h|java|rb|tsx|jsx|vue)$/i;
const TEST_FILE_RE = /\b(?:test|spec|suite)\./i;

/**
 * True when the workspace listing has no source or test scripts (data-only).
 * @param {string[]} [entries] Top-level names from listWorkspaceTopLevel.
 * @returns {boolean}
 */
export function workspaceHasOnlyDataFiles(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.every((name) => {
    const base = String(name).replace(/\/$/, "");
    if (TEST_FILE_RE.test(base)) return false;
    if (SOURCE_OR_TEST_EXT.test(base)) return false;
    return true;
  });
}

/**
 * Instruction names an output artifact and does not name test/verify commands.
 * @param {string} goal
 * @param {{ workspaceEntries?: string[] }} [options]
 * @returns {boolean}
 */
export function isArtifactOnlyGoal(goal, { workspaceEntries } = {}) {
  const text = String(goal ?? "");
  const deliverables = extractNamedDeliverables(text).filter(isCreatedFileDeliverable);
  if (deliverables.length === 0) return false;
  if (isHarborStyleGoal(text)) {
    if (
      extractNamedNodeCommands(text).some(
        (c) => isTestSuiteCommand(c) || /\b(?:pytest|dotnet\s+test)\b/i.test(c),
      )
    ) {
      return false;
    }
  } else if (
    /\b(failing tests?|tests?\s+fail|\brun\b.{0,50}\b(test\.mjs|test\.py|tests?|dotnet\s+run)\b)/i.test(
      text,
    )
  ) {
    return false;
  }
  const named = extractNamedNodeCommands(text).filter((c) => !String(c).startsWith("/"));
  if (named.some((c) => isTestSuiteCommand(c) || /\bdotnet\s+run\b/i.test(c))) return false;
  if (named.some((c) => !isExistenceCheckCommand(c))) return false;
  if (/\b(must print|should print|simulate|sim\b|expected (?:output|value))\b/i.test(text)) {
    return false;
  }
  if (workspaceEntries?.length && !workspaceHasOnlyDataFiles(workspaceEntries)) return false;
  return true;
}

/**
 * Artifact deliverable written with no instruction-named verify command left.
 * @param {string} goal
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function isArtifactOnlyTerminalSuccess(goal, calls) {
  if (!isArtifactOnlyGoal(goal)) return false;
  const deliverables = extractNamedDeliverables(goal).filter(isCreatedFileDeliverable);
  if (!deliverables.every((file) => wroteNamedDeliverable(calls, file))) return false;
  return missingInstructionNamedVerification(goal, calls).length === 0;
}

function missingInstructionNamedVerification(goal, calls) {
  const missing = [];
  for (const cmd of extractNamedNodeCommands(goal).filter((c) => !String(c).startsWith("/"))) {
    if (isExistenceCheckCommand(cmd)) continue;
    if (!ranNamedCommand(calls, cmd)) missing.push(cmd);
  }
  for (const file of extractNamedVerifyFiles(goal)) {
    if (!ranVerifyFile(calls, file, goal)) missing.push(`run ${file}`);
  }
  return missing;
}

/**
 * @param {object} call
 * @returns {boolean}
 */
export function isSuccessfulTestCall(call) {
  if (call?.name !== "run_command" || !call.ok) return false;
  if (call.result?.verificationComplete) return false;
  if (!isTestCommand(runCommandText(call))) return false;
  if (commandExitCode(call.result) !== 0) return false;
  const stdout = commandStdout(call.result).trim();
  if (looksVacuousCliStdout(stdout, runCommandText(call))) return false;
  return true;
}

/**
 * Exit 0 with no useful payload: empty, [], or qty=0 rows and no SKUs.
 * @param {string} stdout
 * @param {string} [command]
 * @param {string} [goal]
 */
export function looksVacuousCliStdout(stdout, command = "", goal = "") {
  if (looksVacuousArchiveExtract(stdout, command)) return true;
  const out = String(stdout ?? "").trim();
  if (out === "[]") return true;
  const cmd = String(command ?? "");
  const g = String(goal ?? "");
  const isCli =
    /\bdotnet\s+run\b/i.test(cmd) ||
    (/\bpython3?\s+\S+\.py\b/i.test(cmd) && !/\btest\.py\b/i.test(cmd)) ||
    /\b(sku|catalog|qty)\b/i.test(g);
  if (!isCli) return false;
  if (!out) return true;
  if (/qty\s*=\s*0/i.test(out)) {
    const stripped = out.replace(/\b(qty|total|price|name|sku)\b/gi, "");
    if (!/[A-Z]{2,}[-_]?\d|[A-Za-z]{3,}/.test(stripped)) return true;
  }
  return false;
}

/**
 * 7z and similar archivers can exit 0 without extracting anything.
 * @param {string} stdout
 * @param {string} [command]
 * @returns {boolean}
 */
export function looksVacuousArchiveExtract(stdout, command = "") {
  if (!/\b7z\b/i.test(String(command ?? ""))) return false;
  const out = String(stdout ?? "").toLowerCase();
  return /no files to process|files:\s*0|\b0 files\b/.test(out);
}

/**
 * Prior stdout from the last successful run of the same command.
 * @param {Array<object>} calls
 * @param {string} cmd
 * @returns {string|null}
 */
export function priorSuccessfulCommandStdout(calls, cmd) {
  const needle = normalizeCommand(cmd);
  if (!needle) return null;
  for (let i = (calls ?? []).length - 1; i >= 0; i--) {
    const c = calls[i];
    if (!isActualRun(c) || commandExitCode(c.result) !== 0) continue;
    if (normalizeCommand(runCommandText(c)) !== needle) continue;
    const out = commandStdout(c.result).trim();
    return out ? out.slice(0, 400) : "(empty stdout)";
  }
  return null;
}

function commandStdout(result) {
  if (result && typeof result === "object") return String(result.stdout ?? "");
  if (typeof result === "string") {
    const match = result.match(/^stdout:\n([\s\S]*)/m);
    return match ? match[1] : "";
  }
  return "";
}

/**
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function hasSuccessfulTestRun(calls) {
  return calls.some(isSuccessfulTestCall);
}

function hasSuccessfulMutation(calls) {
  return calls.some((c) => MUTATING_TOOL_NAMES.has(c.name) && c.ok);
}

/**
 * @param {Array<object>} calls
 * @returns {boolean}
 */
function hasFailedTestRun(calls) {
  return calls.some((c) => {
    if (c?.name !== "run_command" || !c.ok) return false;
    if (!isTestCommand(runCommandText(c))) return false;
    const code = commandExitCode(c.result);
    return code != null && code !== 0;
  });
}

/**
 * Any run_command that exited non-zero (tool ok:true still means shell failure).
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function hasFailedCommandRun(calls) {
  return (calls ?? []).some((c) => {
    if (!isActualRun(c)) return false;
    const code = commandExitCode(c.result);
    return code != null && code !== 0;
  });
}

/**
 * Failed run_command with no later successful run_command (post-fix recovery allowed).
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function hasFailedCommandWithoutRecovery(calls) {
  let lastFailIdx = -1;
  for (let i = 0; i < (calls ?? []).length; i++) {
    const c = calls[i];
    if (!isActualRun(c)) continue;
    const code = commandExitCode(c.result);
    if (code != null && code !== 0) lastFailIdx = i;
  }
  if (lastFailIdx < 0) return false;
  for (let i = lastFailIdx + 1; i < calls.length; i++) {
    const c = calls[i];
    if (isActualRun(c) && commandExitCode(c.result) === 0) return false;
  }
  return true;
}

function looksLikeHeredocCommand(command) {
  const text = String(command ?? "");
  return /<<-?\s*['"]?\w+/.test(text) || /python3?\s+-\s*<</.test(text);
}

/**
 * @param {Array<{toolCalls?: Array<object>}>} steps
 * @returns {number}
 */
export function countHeredocRejections(steps) {
  let count = 0;
  for (const step of steps ?? []) {
    for (const c of step.toolCalls ?? []) {
      if (c.name !== "run_command" || c.ok) continue;
      if (/heredoc|<<\s*/i.test(String(c.error ?? ""))) count++;
    }
  }
  return count;
}

/**
 * Block a second heredoc attempt after one rejection.
 * @param {object} input
 * @returns {string|null}
 */
export function heredocRetryBlock({ toolName, args, steps }) {
  if (toolName !== "run_command") return null;
  const cmd = String(args?.command ?? args?.cmd ?? "");
  if (!looksLikeHeredocCommand(cmd)) return null;
  if (countHeredocRejections(steps) >= 1) {
    return (
      "Blocked: heredoc was already rejected. write_file a .py script, then " +
      "run_command python script.py — do not retry python - <<."
    );
  }
  return null;
}

/**
 * @param {string} answerText
 * @returns {boolean}
 */
export function finalAnswerDescribesRemainingWork(answerText) {
  return /\b(still need|next step|need to write|should write|will write|remaining|not yet written|have not written|todo)\b/i.test(
    String(answerText ?? ""),
  );
}

/**
 * @param {object} input
 * @returns {string|null}
 */
export function introspectionLoopNudge({ goal, steps, nudgeCount }) {
  if (nudgeCount >= 2) return null;
  if (!detectTaskHints(goal).some((h) => h.id === "lookup-and-write")) return null;
  const calls = flattenToolCalls(steps);
  const wrote = calls.some((c) => MUTATING_TOOL_NAMES.has(c.name) && c.ok);
  if (wrote) return null;
  let exploratory = 0;
  for (const c of calls) {
    if (c.name !== "run_command" || !c.ok) continue;
    const cmd = runCommandText(c);
    if (/\b(pip show|python -c|import |dir\(|help\(|--version|which )\b/i.test(cmd)) exploratory++;
  }
  if (exploratory >= 4) return TOOL_NUDGE_INTROSPECTION_LOOP;
  return null;
}

/**
 * A successful read of a non-test, non-doc file (the implementation).
 * @param {Array<object>} calls
 * @returns {boolean}
 */
function hasReadImplementationFile(calls) {
  return calls.some((c) => {
    if (c?.name !== "read_file" || !c.ok) return false;
    const p = String(c.args?.path ?? c.args?.file ?? "");
    if (!p) return false;
    const base = p.replace(/\\/g, "/").split("/").pop() ?? "";
    return !/^test\.(mjs|py|cs)$/i.test(base) && !/\.(md|txt)$/i.test(base);
  });
}

function normalizeCommand(cmd) {
  return String(cmd ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isActualRun(call) {
  return call?.name === "run_command" && call.ok && !call.result?.verificationComplete;
}

function commandAlreadySucceeded(calls, cmd) {
  const needle = normalizeCommand(cmd);
  if (!needle) return false;
  let lastSuccess = -1;
  for (let i = 0; i < (calls ?? []).length; i++) {
    const c = calls[i];
    if (!isActualRun(c)) continue;
    if (commandExitCode(c.result) !== 0) continue;
    if (normalizeCommand(runCommandText(c)) === needle) lastSuccess = i;
  }
  if (lastSuccess < 0) return false;
  // write_file/edit_file or a later script that may clobber outputs (baseline
  // packers, etc.) invalidate the dedup so the agent can re-run the solver.
  for (let i = lastSuccess + 1; i < calls.length; i++) {
    const c = calls[i];
    if (MUTATING_TOOL_NAMES.has(c.name) && c.ok) return false;
    if (!isActualRun(c) || commandExitCode(c.result) !== 0) continue;
    const cmdText = runCommandText(c);
    if (looksLikeOutputClobberCommand(cmdText)) return false;
    if (looksLikeAptSourcesConfigChange(cmdText)) return false;
  }
  if (/\bapt(-get)?\s+update\b/i.test(needle)) {
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      if (!isActualRun(c) || commandExitCode(c.result) !== 0) continue;
      if (looksLikeAptSourcesConfigChange(runCommandText(c)) && i > lastSuccess) return false;
    }
  }
  return true;
}

/**
 * Shell edits to apt sources invalidate a prior successful apt-get update dedup.
 * @param {string} cmd
 */
export function looksLikeAptSourcesConfigChange(cmd) {
  const text = String(cmd ?? "");
  if (!/\b(?:sources\.list|\.sources)\b/i.test(text)) return false;
  return /(?:tee|>>|>|sed\s+-i|\bcp\s+|\bmv\s+|echo\s+[^|]+\|)/i.test(text);
}

export const TOOL_NUDGE_BUILD_RERUN = [
  "Build dependencies were just installed.",
  "Re-run the last failed compile/make/configure command before exploring a new strategy.",
].join(" ");

/**
 * After apt install of build tools, nudge re-running the last failed build step.
 * @param {{ steps?: Array<{ toolCalls?: Array<object> }> }} input
 * @returns {string|null}
 */
export function buildDepsInstallRerunNudge({ steps } = {}) {
  const calls = flattenToolCalls(steps);
  let lastFailedBuild = -1;
  let lastBuildInstall = -1;
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (!isActualRun(c)) continue;
    const cmd = runCommandText(c);
    if (/\b(?:\.\/configure|make\b|cmake|compile\.sh|npm\s+run\s+build|dotnet\s+build)\b/i.test(cmd)) {
      if (commandExitCode(c.result) !== 0) lastFailedBuild = i;
    }
    if (
      /\bapt(-get)?\s+install\b/i.test(cmd) &&
      commandExitCode(c.result) === 0 &&
      /\b(build-essential|gcc|g\+\+|make|cmake)\b/i.test(cmd)
    ) {
      lastBuildInstall = i;
    }
  }
  if (lastBuildInstall < 0 || lastFailedBuild < 0) return null;
  if (lastBuildInstall <= lastFailedBuild) return null;
  const reran = calls.slice(lastBuildInstall + 1).some((c) => {
    if (!isActualRun(c)) return false;
    const cmd = runCommandText(c);
    return /\b(?:\.\/configure|make\b|cmake|compile\.sh)\b/i.test(cmd);
  });
  return reran ? null : TOOL_NUDGE_BUILD_RERUN;
}

/**
 * Shell commands that often overwrite deliverables without write_file
 * (baseline packers, solvers, generators). Smoke `dotnet run` stays excluded.
 * @param {string} cmd
 */
function looksLikeOutputClobberCommand(cmd) {
  const text = String(cmd ?? "");
  if (!text || isDiagnosticCommand(text) || isTestSuiteCommand(text)) return false;
  if (/\bdotnet\s+(run|build|test)\b/i.test(text)) return false;
  if (/\b(baseline\w*|packer|output_data|shape_packer)\b/i.test(text)) return true;
  if (
    /\b(python3?|py|node|bash|sh)\s+[^\s]+\.(py|sh|ps1|mjs|js)\b/i.test(text) &&
    !/\btest\.(py|mjs|js)\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

const SMOKE_SKIP_WORDS = new Set([
  "the", "cli", "a", "an", "one", "invalid", "original", "new", "ones",
  "commands", "command", "plus", "and", "or", "then", "also", "each",
  "named", "required", "main", "both", "all", "with", "from", "for",
  "unknown", "missing", "args", "usage", "json", "node", "python",
  "dotnet", "run", "test", "build", "project", "file", "files",
]);

/**
 * Subcommands named in smoke-test lists or CLI command docs.
 * @param {string} goal
 * @returns {string[]}
 */
export function extractSmokeSubcommands(goal) {
  const text = String(goal ?? "");
  const found = [];
  const pushTokens = (chunk) => {
    for (const part of String(chunk).split(/\s*(?:\/|,|;|\band\b|\bplus\b)\s*/i)) {
      const token = part
        .trim()
        .replace(/^`+|`+$/g, "")
        .replace(/[.:]+$/, "")
        .split(/\s+/)[0];
      if (!token || !/^[a-z][\w-]*$/i.test(token)) continue;
      const lower = token.toLowerCase();
      if (SMOKE_SKIP_WORDS.has(lower)) continue;
      if (!found.includes(lower)) found.push(lower);
    }
  };

  for (const m of text.matchAll(/\bsmoke-test(?:\s+(?:the\s+)?(?:CLI|commands?))?[:\s]+([^.;]+)/gi)) {
    pushTokens(m[1]);
  }

  if (/\b(CLI|dotnet\s+run|subcommand)\b/i.test(text)) {
    for (const m of text.matchAll(/`([a-z][\w-]*)(?:\s+<[^`]+>)?`/gi)) {
      const name = m[1].toLowerCase();
      if (SMOKE_SKIP_WORDS.has(name) || found.includes(name)) continue;
      found.push(name);
    }
  }

  for (const m of text.matchAll(/\bdotnet\s+run(?:\s+--project\s+\S+)?\s+--\s+([a-z][\w-]*)/gi)) {
    const name = m[1].toLowerCase();
    if (!found.includes(name)) found.push(name);
  }

  const trailing = text.match(
    /\bCommands?:\s*`?dotnet\s+run\s+--\s+[a-z][\w-]*`?[,\s]+([^.;]+)/i,
  );
  if (trailing) pushTokens(trailing[1]);

  return found;
}

export function isFollowUpGoal(goal) {
  const text = String(goal ?? "");
  return (
    /\bthis is a new request\b/i.test(text) ||
    /\balready contains a working\b/i.test(text) ||
    /\bdo not rewrite(?: the project)? from scratch\b/i.test(text)
  );
}

function commandCoversSubcommand(cmd, sub) {
  const text = String(cmd ?? "").toLowerCase();
  const s = String(sub ?? "").toLowerCase();
  if (!s) return false;
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`--\\s+${escaped}(?:\\s|$)`).test(text) ||
    new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(text)
  );
}

function ranSubcommand(calls, sub) {
  return (calls ?? []).some((c) => {
    if (!isActualRun(c)) return false;
    return commandCoversSubcommand(runCommandText(c), sub);
  });
}

export function ranNamedCommand(calls, named) {
  const needle = String(named ?? "")
    .toLowerCase()
    .replace(/^(node|python3?|py)\s+/, "");
  if (!needle) return false;
  return (calls ?? []).some((c) => {
    if (!isActualRun(c)) return false;
    if (commandExitCode(c.result) !== 0) return false;
    return runCommandText(c).toLowerCase().includes(needle);
  });
}

function hasCliSmokeRun(calls, goal = "") {
  const named = extractNamedNodeCommands(goal);
  const smoke = extractSmokeSubcommands(goal);
  return (calls ?? []).some((c) => {
    if (!isActualRun(c)) return false;
    const cmd = runCommandText(c);
    if (isDiagnosticCommand(cmd, goal)) return false;
    if (isTestSuiteCommand(cmd)) return false;
    if (named.some((n) => commandCoversNamed(cmd, n))) return true;
    if (smoke.some((s) => commandCoversSubcommand(cmd, s))) return true;
    return false;
  });
}

function commandCoversNamed(cmd, named) {
  const needle = String(named ?? "")
    .toLowerCase()
    .replace(/^(node|python3?|py)\s+/, "");
  if (!needle) return false;
  return String(cmd ?? "").toLowerCase().includes(needle);
}

/**
 * Whether this command is an explicit verification named in the goal
 * (test suite, pytest, or a path/CLI the instruction asked to run).
 * @param {string} cmd
 * @param {string} [goal]
 * @returns {boolean}
 */
export function isTaskNamedVerificationCommand(cmd, goal = "") {
  const text = String(cmd ?? "");
  if (isTestSuiteCommand(text)) return true;
  if (looksLikeDiagnostic(text) && !isExistenceCheckCommand(text)) return false;
  const named = extractNamedNodeCommands(goal);
  const n = normalizeCommand(text);
  if (!n) return false;
  return named.some((c) => {
    const needle = normalizeCommand(c);
    if (!needle) return false;
    if (n === needle) return true;
    if (needle.startsWith("/")) {
      return n.startsWith(needle) || n.startsWith(`test -f ${needle}`);
    }
    return n.includes(needle);
  });
}

/**
 * Output files and binaries the instruction asks to produce or invoke.
 * @param {string} goal
 * @returns {string[]}
 */
/** @type {RegExp} */
const NUMBERED_DELIVERABLE_RE =
  /^\s*\d+[.)]\s+[^\n]*?([\w./-]+\.[A-Za-z0-9]+)/gim;

export function extractNamedDeliverables(goal) {
  const text = String(goal ?? "");
  const found = [];
  const push = (raw) => {
    const value = String(raw ?? "")
      .replace(/^[`'"]+|[`'".;,:]+$/g, "")
      .replace(/[.,;:]+$/, "");
    if (!value || value.length < 3) return;
    if (found.includes(value)) return;
    found.push(value);
  };

  for (const m of text.matchAll(
    /\b(?:titled|named|called)\s+[`'"]?([\w./-]+\.[A-Za-z0-9]+)/gi,
  )) {
    push(m[1]);
  }
  for (const m of text.matchAll(
    /\b(?:create|write|save|produce|generate)\s+(?:an?\s+)?(?:output\s+)?(?:(?:fasta|text|json)\s+)?(?:file\s+)?(?:titled|named|called)?\s*[`'"]?([\w./-]+\.(fasta|fa|txt|json|csv|out|md|xml|yml|yaml|html|tsv))[`'"]?/gi,
  )) {
    push(m[1]);
  }
  for (const m of text.matchAll(
    /\boutput(?:\s+fasta)?\s+file\s+(?:should\s+be\s+)?(?:titled|named|called)\s+[`'"]?([\w./-]+\.[A-Za-z0-9]+)/gi,
  )) {
    push(m[1]);
  }
  for (const m of text.matchAll(/(\/(?:tmp|app|opt|usr)\/[\w.-]+\/[\w./-]+)/g)) {
    push(m[1]);
  }
  for (const m of text.matchAll(NUMBERED_DELIVERABLE_RE)) {
    push(m[1]);
  }
  return found;
}

/**
 * File paths mentioned in numbered instruction steps (1. … file.py).
 * @param {string} goal
 * @returns {string[]}
 */
export function extractNumberedDeliverablePaths(goal) {
  const text = String(goal ?? "");
  const found = [];
  for (const m of text.matchAll(NUMBERED_DELIVERABLE_RE)) {
    const value = String(m[1] ?? "").replace(/[.,;:]+$/, "");
    if (!value || found.includes(value)) continue;
    found.push(value);
  }
  return found;
}

export function isCreatedFileDeliverable(filePath) {
  return DATA_FILE_EXT.test(String(filePath ?? ""));
}

export function isHarborStyleGoal(goal) {
  return /\/tmp\/|\/app\/|\/hidden_tests\b/i.test(String(goal ?? ""));
}

/**
 * @param {string} goal
 * @returns {boolean}
 */
export function isMlPyTorchGoal(goal) {
  const text = String(goal ?? "");
  return (
    /\b(torch|pytorch|pipeline.?parallel|distributed|train_step\w*|tensor|nn\.Module)\b/i.test(text) ||
    /\b\/tests\b/.test(text) ||
    isPytorchModelCliGoal(text) ||
    detectTaskHints(text).some((h) => h.id === "pytorch-ml" || h.id === "pytorch-model-cli")
  );
}

/**
 * @param {string} goal
 * @returns {boolean}
 */
export function isPytorchModelCliGoal(goal) {
  const text = String(goal ?? "");
  return /\bweights\.json\b/i.test(text) && /\bcli_tool\b/i.test(text);
}

/**
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function ranPytorchCliSmoke(calls) {
  return (calls ?? []).some((c) => {
    if (!isActualRun(c) || commandExitCode(c.result) !== 0) return false;
    const cmd = runCommandText(c);
    return /\bcli_tool\b/.test(cmd) && /\bweights\.json\b/.test(cmd) && /\.(?:png|jpe?g|bmp)\b/i.test(cmd);
  });
}

/**
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function wrotePythonDeliverable(calls) {
  return (calls ?? []).some((c) => {
    if (!c.ok || !MUTATING_TOOL_NAMES.has(c.name)) return false;
    return /\.py$/i.test(String(c.result?.path ?? c.args?.path ?? ""));
  });
}

/**
 * py_compile passed but no pytest/functional test run.
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function hasPyCompileOnlyWithoutFunctionalTest(calls) {
  const list = calls ?? [];
  const compiled = list.some(
    (c) =>
      isActualRun(c) &&
      commandExitCode(c.result) === 0 &&
      /\bpy_compile\b/.test(runCommandText(c)),
  );
  const functional = list.some(
    (c) =>
      isActualRun(c) &&
      commandExitCode(c.result) === 0 &&
      (/\bpytest\b/.test(runCommandText(c)) || isSuccessfulTestCall(c)),
  );
  return compiled && !functional;
}

function wroteNamedDeliverable(calls, name) {
  const needle = String(name ?? "").replace(/\\/g, "/");
  const base = needle.split("/").pop();
  if (!base) return false;
  const viaWrite = (calls ?? []).some((c) => {
    if (!c.ok) return false;
    if (c.name !== "write_file" && c.name !== "edit_file") return false;
    const p = String(c.result?.path ?? c.args?.path ?? "").replace(/\\/g, "/");
    if (!p) return false;
    return p === needle || p.endsWith(`/${base}`) || p.split("/").pop() === base;
  });
  if (viaWrite) return true;
  return (calls ?? []).some((c) => {
    if (!isActualRun(c) || commandExitCode(c.result) !== 0) return false;
    const cmd = runCommandText(c);
    if (!/[>&]/.test(cmd)) return false;
    return cmd.includes(base) || cmd.includes(needle);
  });
}

function ranDeliverableSmoke(calls, pathName) {
  const needle = String(pathName ?? "").toLowerCase();
  if (!needle) return false;
  return (calls ?? []).some((c) => {
    if (!isActualRun(c) || commandExitCode(c.result) !== 0) return false;
    const cmd = runCommandText(c).toLowerCase();
    if (!cmd.includes(needle)) return false;
    if (isDiagnosticCommand(cmd)) return false;
    return true;
  });
}

/**
 * Goals where file-exists is insufficient — behavioral stdout is required.
 * @param {string} goal
 * @returns {boolean}
 */
export function goalRequiresBehavioralVerification(goal) {
  if (isArtifactOnlyGoal(goal)) return false;
  const text = String(goal ?? "");
  if (goalRequiresTestVerify(text)) return true;
  if (extractNamedNodeCommands(text).some((c) => !String(c).startsWith("/"))) return true;
  if (extractSmokeSubcommands(text).length > 0) return true;
  if (/\b(must print|should print|prints?\s+(?:the\s+)?(?:value|result|output)|simulate|sim\b|expected (?:output|value)|stdout)\b/i.test(text)) {
    return true;
  }
  return detectTaskHints(text).some((h) =>
    ["computation-deliverable", "numeric-artifact", "test-verify", "script-smoke", "artifact-create"].includes(
      h.id,
    ),
  );
}

/**
 * @param {Array<object>} calls
 * @param {string} goal
 * @returns {boolean}
 */
export function hasBehavioralVerification(calls, goal) {
  if (hasSuccessfulTestRun(calls)) return true;
  if (hasCliSmokeRun(calls, goal)) return true;
  const named = extractNamedNodeCommands(goal).filter((c) => !String(c).startsWith("/"));
  if (named.some((cmd) => ranNamedCommand(calls, cmd))) return true;
  return (calls ?? []).some((c) => {
    if (!isActualRun(c) || commandExitCode(c.result) !== 0) return false;
    const cmd = runCommandText(c);
    if (isDiagnosticCommand(cmd, goal) || isExistenceCheckCommand(cmd)) return false;
    if (isTaskNamedVerificationCommand(cmd, goal)) return true;
    return commandStdout(c.result).trim().length > 0;
  });
}

function callResultText(call) {
  const parts = [];
  const r = call?.result;
  if (typeof r === "string") parts.push(r);
  else if (r && typeof r === "object") {
    parts.push(
      String(r.stdout ?? ""),
      String(r.stderr ?? ""),
      String(r.note ?? ""),
      String(r.status ?? ""),
    );
  }
  if (call?.error) parts.push(String(call.error));
  if (call?.name === "write_file") parts.push(String(call.args?.content ?? ""));
  if (call?.name === "edit_file") parts.push(String(call.args?.new_string ?? ""));
  return parts.join("\n");
}

/**
 * Git conflict markers or `CONFLICT (` from merge output.
 * @param {object} call
 * @returns {boolean}
 */
export function callHasConflictEvidence(call) {
  const text = callResultText(call);
  return /^<<<<<<< /m.test(text) || /^>>>>>>> /m.test(text) || /\bCONFLICT \(/i.test(text);
}

/**
 * True when the latest conflict evidence has not been followed by an edit.
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function unresolvedMergeConflict(calls) {
  let last = -1;
  for (let i = 0; i < (calls ?? []).length; i++) {
    if (callHasConflictEvidence(calls[i])) last = i;
  }
  if (last < 0) return false;
  return !calls.slice(last + 1).some((c) => MUTATING_TOOL_NAMES.has(c.name) && c.ok);
}

export function isMergeConflictGoal(goal) {
  return /\b(merge conflict|git merge|unmerged|conflict markers?)\b|\b<<<<<<<\b/i.test(
    String(goal ?? ""),
  );
}

/**
 * Fixtures the instruction names as verification inputs (not files to create).
 * @param {string} goal
 * @returns {string[]}
 */
export function extractNamedVerifyFiles(goal) {
  const text = String(goal ?? "");
  const found = [];
  const push = (raw) => {
    const value = String(raw ?? "")
      .replace(/^[`'"]+|[`'".;,:]+$/g, "");
    if (!value || found.includes(value)) return;
    found.push(value);
  };
  for (const m of text.matchAll(
    /\b(?:run|verify|check|against|via)\b[^.\n]{0,80}\b([\w./-]+\.json)\b/gi,
  )) {
    push(m[1]);
  }
  if (/\bexamples\.json\b/i.test(text)) push("examples.json");
  return found;
}

function ranVerifyFile(calls, name, goal) {
  const needle = String(name ?? "").toLowerCase();
  if (!needle) return false;
  return (calls ?? []).some((c) => {
    if (!isActualRun(c) || commandExitCode(c.result) !== 0) return false;
    const cmd = runCommandText(c);
    if (isDiagnosticCommand(cmd, goal)) return false;
    return cmd.toLowerCase().includes(needle);
  });
}

function hasGitCommit(calls) {
  return (calls ?? []).some((c) => {
    if (!isActualRun(c)) return false;
    return /\bgit\s+commit\b/i.test(runCommandText(c));
  });
}

/**
 * Install succeeded and a non-install run_command succeeded afterward.
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function hasInstallAndRunSuccess(calls) {
  let installIdx = -1;
  for (let i = 0; i < (calls ?? []).length; i++) {
    const c = calls[i];
    if (!isActualRun(c) || commandExitCode(c.result) !== 0) continue;
    const cmd = runCommandText(c);
    if (/\b(pip install|apt(-get)? install|npm install|uv pip install)\b/i.test(cmd)) {
      installIdx = i;
    }
  }
  if (installIdx < 0) return false;
  for (let i = installIdx + 1; i < calls.length; i++) {
    const c = calls[i];
    if (!isActualRun(c) || commandExitCode(c.result) !== 0) continue;
    const cmd = runCommandText(c);
    if (/\b(pip install|apt(-get)? install|npm install)\b/i.test(cmd)) continue;
    if (/\b(python3?|node|\.\/|bash\s+\S+\.(?:py|sh))\b/i.test(cmd)) return true;
  }
  return false;
}

/**
 * Required verification that has not yet been recorded.
 * @param {string} goal
 * @param {Array<object>} calls
 * @returns {string[]}
 */
export function missingRequiredVerification(goal, calls) {
  const missing = [];
  if (isFollowUpGoal(goal) && !hasSuccessfulMutation(calls)) {
    missing.push("implement the newly requested commands (edit existing files)");
  }
  if (unresolvedMergeConflict(calls)) {
    missing.push("resolve merge conflict with edit_file/write_file (do not stop after git show)");
  } else if (
    (isMergeConflictGoal(goal) || detectTaskHints(goal).some((h) => h.id === "merge-conflict")) &&
    (calls ?? []).some(callHasConflictEvidence) &&
    hasSuccessfulMutation(calls) &&
    !hasGitCommit(calls)
  ) {
    missing.push("git add and git commit the resolved files");
  }
  if (goalRequiresTestVerify(goal) && !hasSuccessfulTestRun(calls)) {
    missing.push("run the test command until it exits 0");
  }
  const named = extractNamedNodeCommands(goal).filter(
    (c) => !/\btest\.(mjs|py)\b/i.test(c) && !/\bdotnet\s+test\b/i.test(c),
  );
  for (const cmd of named) {
    if (String(cmd).startsWith("/")) {
      if (!ranDeliverableSmoke(calls, cmd)) missing.push(cmd);
      continue;
    }
    if (!ranNamedCommand(calls, cmd)) missing.push(cmd);
  }
  const smoke = extractSmokeSubcommands(goal);
  if (smoke.length > 0) {
    for (const sub of smoke) {
      if (!ranSubcommand(calls, sub)) missing.push(`smoke ${sub}`);
    }
  } else if (/\bsmoke-test\b/i.test(String(goal ?? "")) && !hasCliSmokeRun(calls, goal)) {
    missing.push("smoke-test the CLI with at least one run_command");
  }
  const verifyFiles = extractNamedVerifyFiles(goal);
  const createdDeliverables = extractNamedDeliverables(goal).filter(isCreatedFileDeliverable);
  for (const file of createdDeliverables) {
    if (verifyFiles.some((v) => v.toLowerCase() === String(file).toLowerCase())) continue;
    if (!wroteNamedDeliverable(calls, file)) missing.push(`create ${file}`);
  }
  for (const file of extractNumberedDeliverablePaths(goal)) {
    if (wroteNamedDeliverable(calls, file)) continue;
    if (missing.some((m) => m === `create ${file}`)) continue;
    missing.push(`create ${file}`);
  }
  if (
    detectTaskHints(goal).some((h) => h.id === "install-and-run") &&
    !hasInstallAndRunSuccess(calls)
  ) {
    missing.push("install dependencies and run the named script (both must exit 0)");
  }
  if (
    createdDeliverables.some((file) => wroteNamedDeliverable(calls, file)) &&
    goalRequiresBehavioralVerification(goal) &&
    !hasBehavioralVerification(calls, goal)
  ) {
    missing.push("run behavioral verification (named command with expected stdout)");
  }
  if (isArtifactOnlyTerminalSuccess(goal, calls)) {
    return missing.filter(
      (item) =>
        item !== "run the test command until it exits 0" &&
        !/behavioral verification/i.test(item),
    );
  }
  for (const file of verifyFiles) {
    if (!ranVerifyFile(calls, file, goal)) missing.push(`run ${file}`);
  }
  if (
    isMlPyTorchGoal(goal) &&
    wrotePythonDeliverable(calls) &&
    hasPyCompileOnlyWithoutFunctionalTest(calls)
  ) {
    missing.push("run pytest on /tests (py_compile alone is not functional verification)");
  }
  if (isPytorchModelCliGoal(goal) && !ranPytorchCliSmoke(calls)) {
    missing.push("./cli_tool weights.json <image.png> must exit 0 with single-digit stdout");
  }
  return missing;
}

/**
 * Refuse re-running the same command or diagnostics after a successful
 * verify. Different smoke commands stay allowed until the task checklist
 * is complete.
 * @param {object} input
 * @param {string} [input.goal]
 * @param {Array<{toolCalls?: Array<object>}>} input.steps
 * @param {string} input.toolName
 * @param {object} [input.args]
 * @returns {string|null}
 */
export function redundantVerifyBlock({ goal, steps, toolName, args }) {
  if (toolName !== "run_command") return null;
  const cmd = String(args?.command ?? args?.cmd ?? "");
  const calls = flattenToolCalls(steps);
  const missing = missingRequiredVerification(goal, calls);

  if (
    missing.length > 0 &&
    isExistenceCheckCommand(cmd) &&
    extractNamedDeliverables(goal).some((d) => {
      const base = String(d).split("/").pop();
      return cmd.includes(d) || (base && cmd.includes(base));
    })
  ) {
    return null;
  }

  if (commandAlreadySucceeded(calls, cmd)) {
    const priorOut = priorSuccessfulCommandStdout(calls, cmd);
    const stdoutHint = priorOut ? ` Prior stdout: ${priorOut}` : "";
    if (missing.length > 0) {
      return [
        "status: blocked",
        `command: ${cmd}`,
        "That exact command already exited 0 — do not re-run it.",
        stdoutHint,
        `Still required: ${missing.slice(0, 5).join("; ")}.`,
      ].join(" ");
    }
    if (isTaskNamedVerificationCommand(cmd, goal) || isTestCommand(cmd)) {
      return TOOL_NUDGE_ALREADY_VERIFIED;
    }
    return [
      "status: blocked",
      `command: ${cmd}`,
      "That exact command already exited 0 — do not re-run it.",
      stdoutHint,
      "If a later command overwrote outputs, say so and the next distinct command may re-run after a write or different successful shell step.",
    ].join(" ");
  }

  const namedVerifySucceeded = calls.some(
    (c) =>
      isActualRun(c) &&
      commandExitCode(c.result) === 0 &&
      (isSuccessfulTestCall(c) || isTaskNamedVerificationCommand(runCommandText(c), goal)),
  );

  if (isDiagnosticCommand(cmd, goal) && namedVerifySucceeded) {
    if (missing.length > 0) {
      return [
        "status: blocked",
        `command: ${cmd}`,
        "Do not run diagnostic commands.",
        `Still required: ${missing.slice(0, 5).join("; ")}.`,
      ].join(" ");
    }
    return `${TOOL_NUDGE_DIAGNOSTIC_BLOCKED} command: ${cmd}`;
  }

  return null;
}

/**
 * Whether mutating tools were used before any run_command (test-fix violation).
 * @param {Array<object>} calls
 * @returns {boolean}
 */
export function mutatedBeforeTestRun(calls) {
  let sawRun = false;
  for (const call of calls) {
    if (call.name === "run_command") {
      sawRun = true;
      continue;
    }
    if (MUTATING_TOOL_NAMES.has(call.name) && call.ok && !sawRun) return true;
  }
  return false;
}

/**
 * Extract likely verify commands mentioned in the goal (node …).
 * @param {string} goal
 * @returns {string[]}
 */
export function extractNamedNodeCommands(goal) {
  const text = String(goal ?? "");
  const found = [];
  const patterns = [
    /\bnode\s+[\w./-]+(?:\s+[\w./=-]+)*/gi,
    /\bpython3?\s+[\w./-]+(?:\s+[\w./=-]+)*/gi,
    /\bpy\s+[\w./-]+(?:\s+[\w./=-]+)*/gi,
    /\bdotnet\s+(?:run|test|build)(?:\s+[\w./=-]+)*/gi,
    /\bpytest\b(?:\s+[\w./=-]+)*/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const cmd = m[0]
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[.,;:]+$/, "");
      if (!found.includes(cmd)) found.push(cmd);
    }
  }
  for (const pathName of extractNamedDeliverables(text)) {
    if (isCreatedFileDeliverable(pathName)) continue;
    if (!found.includes(pathName)) found.push(pathName);
  }
  return found;
}

/**
 * @param {string} goal
 * @returns {boolean}
 */
export function goalRequiresTestVerify(goal) {
  if (isHarborStyleGoal(goal)) {
    return extractNamedNodeCommands(goal).some(
      (c) => isTestSuiteCommand(c) || /\b(?:pytest|dotnet\s+test)\b/i.test(c),
    );
  }
  const hints = detectTaskHints(goal);
  if (hints.some((h) => h.id === "test-fix" || h.id === "test-verify")) return true;
  return /\brun\b.{0,50}\b(test\.mjs|test\.py|tests?|dotnet\s+run)\b/i.test(String(goal ?? ""));
}

/**
 * Soft-block mutating tools until a pre-fix test run for test-fix goals.
 * @param {object} input
 * @param {string} input.goal
 * @param {string} input.toolName
 * @param {Array<{toolCalls?: Array<object>}>} input.steps
 * @returns {string|null} Error message to return instead of executing, or null.
 */
export function mutationBlockedUntilPretest({ goal, toolName, steps }) {
  if (!MUTATING_TOOL_NAMES.has(toolName)) return null;
  const hints = detectTaskHints(goal);
  if (!hints.some((h) => h.id === "test-fix")) return null;
  const calls = flattenToolCalls(steps);
  if (hasRunCommand(calls)) return null;
  return MUTATION_BLOCKED_PRETEST;
}

/**
 * Pull C# / compiler diagnostic lines out of command output so failures are
 * not buried in build noise.
 * @param {string} text
 * @returns {string}
 */
export function extractCompilerDiagnostics(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const hits = lines.filter((line) =>
    /\berror\s+CS\d{4}\b|\bCS\d{4}\b|\berror\s+[A-Z]{2}\d{3,4}\b/i.test(line),
  );
  return [...new Set(hits.map((l) => l.trim()))].slice(0, 20).join("\n");
}

export const TOOL_NUDGE_DIAGNOSTIC_FINAL_ANSWER = [
  "Do not cite environment probes (node -v, python --version, apt-get --version) as task verification.",
  "State only files you changed and instruction-named commands that exited 0.",
].join(" ");

/**
 * @param {string} answerText
 * @returns {boolean}
 */
export function finalAnswerCitesDiagnostics(answerText) {
  return /\b(node|nodejs|python3?|py)\s+(-v|--version|-V)\b|\bapt(-get)?\s+--version\b|\buname\b|\bwhich\b/i.test(
    String(answerText ?? ""),
  );
}

/**
 * Block completion when the final answer treats probes as verification.
 * @param {object} input
 * @returns {string|null}
 */
export function diagnosticProbeFinalNudge({ answerText, nudgeCount }) {
  const MAX_TOOL_NUDGES = 2;
  if (nudgeCount >= MAX_TOOL_NUDGES) return null;
  if (!String(answerText ?? "").trim()) return null;
  if (!finalAnswerCitesDiagnostics(answerText)) return null;
  return TOOL_NUDGE_DIAGNOSTIC_FINAL_ANSWER;
}

/**
 * Block asking the user for signatures/details when the deliverable is already on disk.
 * @param {object} input
 * @returns {string|null}
 */
export function deliverableSignatureAskNudge({ answerText, steps, nudgeCount }) {
  const MAX_TOOL_NUDGES = 2;
  if (nudgeCount >= MAX_TOOL_NUDGES) return null;
  const answer = String(answerText ?? "");
  if (!answer.trim()) return null;
  if (
    !/\b(signature|clarif|please provide|what should (?:the|my|a)|could you (?:provide|specify)|do you want)\b/i.test(
      answer,
    )
  ) {
    return null;
  }
  if (!wrotePythonDeliverable(flattenToolCalls(steps))) return null;
  return (
    "You already wrote the Python deliverable — read_file it and finish with what is on disk. " +
    "Do not ask the user for a signature or parameters you should infer from tests/callers."
  );
}

/**
 * Block completion when the model tries to finish with an empty message.
 * @param {object} input
 * @param {string} input.goal
 * @param {string} input.answerText
 * @param {Array<{toolCalls?: Array<{name: string, ok?: boolean}>}>} input.steps
 * @param {number} input.nudgeCount
 * @returns {string|null}
 */
export function emptyFinalAnswerNudge({ goal, answerText, steps, nudgeCount }) {
  const MAX_TOOL_NUDGES = 2;
  if (nudgeCount >= MAX_TOOL_NUDGES) return null;
  if (String(answerText ?? "").trim()) return null;

  const hints = detectTaskHints(goal);
  const usedTools = substantiveToolsUsed(steps).size > 0 || anyToolCallsExecuted(steps);
  if (hints.some((h) => h.id === "path-answer") || isQuestionGoal(goal)) {
    return usedTools ? TOOL_NUDGE_EMPTY_VALUE : TOOL_NUDGE_EMPTY_ANSWER;
  }
  if (usedTools) return TOOL_NUDGE_EMPTY_AFTER_TOOLS;
  if (goalNeedsSubstantiveTools(goal)) return TOOL_NUDGE_EMPTY_ANSWER;
  return TOOL_NUDGE_EMPTY_AFTER_TOOLS;
}

export function prematureFinalNudge({ goal, answerText, steps, nudgeCount }) {
  const MAX_TOOL_NUDGES = 2;
  if (nudgeCount >= MAX_TOOL_NUDGES) return null;
  if (!String(answerText ?? "").trim()) return null;

  if (!goalNeedsSubstantiveTools(goal)) return null;
  if (substantiveToolsUsed(steps).size > 0) return null;
  if (!anyToolCallsExecuted(steps)) return TOOL_NUDGE_NO_TOOLS;
  return null;
}

/**
 * Rubric-aware self-check before completion: missing pretest / verify runs.
 * @param {object} input
 * @param {string} input.goal
 * @param {string} input.answerText
 * @param {Array<{toolCalls?: Array<object>}>} input.steps
 * @param {number} input.nudgeCount
 * @returns {string|null}
 */
export function completionVerifyNudge({ goal, answerText, steps, nudgeCount }) {
  const MAX_TOOL_NUDGES = 2;
  if (nudgeCount >= MAX_TOOL_NUDGES) return null;

  const calls = flattenToolCalls(steps);
  const hints = detectTaskHints(goal);
  const answer = String(answerText ?? "");
  const claimsSuccess = SUCCESS_CLAIM.test(answer);

  if (hints.some((h) => h.id === "test-fix")) {
    if (!hasRunCommand(calls)) return TOOL_NUDGE_PRETEST;
    if (mutatedBeforeTestRun(calls) && !hasSuccessfulTestRun(calls)) {
      return TOOL_NUDGE_PRETEST;
    }
    if (hasFailedTestRun(calls) && !hasSuccessfulMutation(calls)) return TOOL_NUDGE_FIX_IMPL;
    if (!hasSuccessfulMutation(calls) && !hasReadImplementationFile(calls)) {
      return TOOL_NUDGE_READ_IMPL;
    }
    // Edits happened — require a post-fix verify run (any successful test run after last mutate).
    const lastMutateIdx = (() => {
      let idx = -1;
      for (let i = 0; i < calls.length; i++) {
        if (MUTATING_TOOL_NAMES.has(calls[i].name) && calls[i].ok) idx = i;
      }
      return idx;
    })();
    if (lastMutateIdx >= 0) {
      const after = calls.slice(lastMutateIdx + 1);
      if (!hasSuccessfulTestRun(after)) return TOOL_NUDGE_VERIFY;
    }
  }

  if (goalRequiresTestVerify(goal)) {
    if (!hasSuccessfulTestRun(calls)) {
      if (!isArtifactOnlyGoal(goal) && (claimsSuccess || substantiveToolsUsed(steps).size > 0)) {
        return TOOL_NUDGE_VERIFY;
      }
    }
  }

  if (
    isMlPyTorchGoal(goal) &&
    wrotePythonDeliverable(calls) &&
    hasPyCompileOnlyWithoutFunctionalTest(calls) &&
    (claimsSuccess || substantiveToolsUsed(steps).size > 0 || !String(answerText ?? "").trim())
  ) {
    return "Do not finish yet — run pytest on /tests (or the instruction's test command). py_compile only checks syntax, not behavior.";
  }

  if (
    isPytorchModelCliGoal(goal) &&
    !ranPytorchCliSmoke(calls) &&
    (claimsSuccess || substantiveToolsUsed(steps).size > 0 || !String(answerText ?? "").trim())
  ) {
    return "Do not finish yet — run ./cli_tool weights.json <image.png> and confirm exit 0 with a single-digit prediction on stdout.";
  }

  if (
    claimsSuccess &&
    /\b(fix|edit|repair|bug|broken|sanitiz\w*|secrets?|credential)\b/i.test(String(goal ?? "")) &&
    !hasSuccessfulMutation(calls) &&
    !hasSuccessfulTestRun(calls)
  ) {
    return TOOL_NUDGE_CLAIM_NO_MUTATION;
  }
  if (
    /\b(sanitiz\w*|secrets?|credential|AKIA|ghp_|hf_)\b/i.test(String(goal ?? "")) &&
    !hasSuccessfulMutation(calls) &&
    (claimsSuccess || substantiveToolsUsed(steps).size > 0)
  ) {
    return TOOL_NUDGE_CLAIM_NO_MUTATION;
  }
  if (claimsSuccess && hasFailedTestRun(calls) && !hasSuccessfulTestRun(calls)) {
    return TOOL_NUDGE_VERIFY;
  }

  const drift = deliverableDriftNudge({ goal, steps });
  if (drift && (claimsSuccess || !String(answerText ?? "").trim())) {
    return drift;
  }

  const missing = missingRequiredVerification(goal, calls).filter(
    (item) => item !== "run the test command until it exits 0",
  );
  const emptyAnswer = !String(answerText ?? "").trim();
  if (
    finalAnswerDescribesRemainingWork(answerText) &&
    missing.some((item) => String(item).startsWith("create "))
  ) {
    return TOOL_NUDGE_REMAINING_WORK;
  }
  if (missing.length > 0 && (claimsSuccess || emptyAnswer || substantiveToolsUsed(steps).size > 0)) {
    if (missing.includes("implement the newly requested commands (edit existing files)")) {
      return TOOL_NUDGE_FOLLOW_UP;
    }
    if (missing.some((item) => /merge conflict/i.test(item))) {
      return TOOL_NUDGE_MERGE_CONFLICT;
    }
    if (missing.some((item) => String(item).startsWith("create "))) {
      return TOOL_NUDGE_DELIVERABLE;
    }
    if (missing.some((item) => /behavioral verification/i.test(item))) {
      return TOOL_NUDGE_DELIVERABLE_VERIFY;
    }
    return `Do not finish yet — still need: ${missing.slice(0, 5).join("; ")}.`;
  }
  if (
    (steps ?? []).length >= 4 &&
    extractNamedDeliverables(goal).filter(isCreatedFileDeliverable).length > 0 &&
    !hasSuccessfulMutation(calls) &&
    (claimsSuccess || emptyAnswer)
  ) {
    const remaining = missing.length
      ? missing.slice(0, 5).join("; ")
      : extractNamedDeliverables(goal)
          .filter(isCreatedFileDeliverable)
          .map((f) => `create ${f}`)
          .join("; ");
    return `Do not finish yet — required output still missing after ${steps.length} steps. Still need: ${remaining}.`;
  }

  if (
    missing.length === 0 &&
    (claimsSuccess || /\b(done|complete|finished|success)\b/i.test(String(answerText ?? ""))) &&
    hasFailedCommandWithoutRecovery(calls)
  ) {
    return "Do not claim success — a run_command exited non-zero (tool ok:true still means the shell failed). Read stderr, fix, and re-run.";
  }

  return null;
}

/**
 * Combined nudge used by the agent loop when the model tries to finish.
 * @param {object} input
 * @returns {string|null}
 */
export function finalAnswerNudge(input) {
  if (
    shouldFailOnEmptyResponses({
      goal: input.goal,
      steps: input.steps,
      consecutiveEmpty: input.consecutiveEmpty ?? 0,
    })
  ) {
    return null;
  }
  return (
    prematureFinalNudge(input) ??
    introspectionLoopNudge(input) ??
    completionVerifyNudge(input) ??
    deliverableSignatureAskNudge(input) ??
    diagnosticProbeFinalNudge(input) ??
    emptyFinalAnswerNudge(input)
  );
}

/**
 * Last-resort non-empty answer when the model stops with empty content.
 * @param {object} input
 * @param {string} [input.goal]
 * @param {Array<{toolCalls?: Array<object>}>} [input.steps]
 * @returns {string}
 */
export function synthesizeFinalAnswer({ goal, steps } = {}) {
  const calls = flattenToolCalls(steps);
  const lines = [
    "The model returned an empty final answer. Summary of work so far:",
  ];
  const written = [];
  for (const c of calls) {
    if (!c.ok) continue;
    if (c.name !== "write_file" && c.name !== "edit_file") continue;
    const file = c.result?.path ?? c.args?.path;
    if (file) written.push(String(file));
  }
  const runs = calls.filter((c) => c.name === "run_command");
  if (written.length) lines.push(`Files changed: ${[...new Set(written)].join(", ")}.`);
  else if (runs.some((c) => c.ok && c.result?.status !== "blocked")) {
    lines.push(
      "No files were created or edited via write_file/edit_file, but run_command succeeded — do not claim that no work was done.",
    );
  } else lines.push("No files were created or edited.");
  if (runs.length) {
    const recent = runs.slice(-5).map((c) => {
      const cmd = runCommandText(c) || "(unknown command)";
      if (c.result?.status === "blocked") return `${cmd} → blocked (not executed)`;
      if (c.result?.verificationComplete) return `${cmd} → already verified (not re-run)`;
      const code = commandExitCode(c.result);
      return `${cmd} → exit ${code ?? "?"}`;
    });
    lines.push(`Commands: ${recent.join("; ")}.`);
  }

  const missing = missingRequiredVerification(goal, calls);
  if (missing.length) {
    lines.push(`Still required: ${missing.slice(0, 5).join("; ")}.`);
  } else if (!written.length && extractNamedDeliverables(goal).some(isCreatedFileDeliverable)) {
    lines.push("The named output artifact was not created.");
  }
  return lines.join(" ");
}

/**
 * After tools have already satisfied verification, tell the model to stop
 * instead of re-running tests or launching diagnostics (node -v, etc.).
 * @param {object} input
 * @returns {string|null}
 */
export function alreadyVerifiedFinishNudge({ goal, steps, nudgeCount }) {
  if (nudgeCount >= 1) return null;
  if (!steps?.length) return null;
  const last = steps[steps.length - 1];
  const lastCalls = last?.toolCalls ?? [];
  if (!lastCalls.some((c) => c.name === "run_command")) return null;
  const lastRun = [...lastCalls].reverse().find((c) => c.name === "run_command");
  if (String(lastRun?.result?.status ?? "") === "blocked") return null;
  const complete = lastRun?.result?.verificationComplete === true;
  if (!complete && isDiagnosticCommand(runCommandText(lastRun), goal)) return null;
  if (!complete && commandExitCode(lastRun?.result) !== 0) return null;
  if (
    !complete &&
    looksVacuousCliStdout(commandStdout(lastRun?.result), runCommandText(lastRun), goal)
  ) {
    return null;
  }
  if (missingRequiredVerification(goal, flattenToolCalls(steps)).length > 0) return null;
  const stillNeedsVerify = completionVerifyNudge({
    goal,
    answerText: "completed successfully",
    steps,
    nudgeCount: 0,
  });
  if (stillNeedsVerify) return null;
  const calls = flattenToolCalls(steps);
  if (
    !hasSuccessfulTestRun(calls) &&
    extractNamedNodeCommands(goal).length === 0 &&
    extractSmokeSubcommands(goal).length === 0 &&
    !complete
  ) {
    return null;
  }
  return TOOL_NUDGE_ALREADY_VERIFIED;
}

/**
 * Duplicate-call guard copy. When verification already passed, point the
 * model at the final answer instead of `node -v`.
 * @param {object} input
 * @returns {string}
 */
export function repeatedToolCallMessage({ repeatedCount, goal, steps }) {
  const verified = alreadyVerifiedFinishNudge({ goal, steps, nudgeCount: 0 });
  const base =
    `You have made this exact tool call ${repeatedCount + 1} times in a row; ` +
    "it was not executed again.";
  if (verified) return `${base} ${verified}`;
  return (
    `${base} Do something different: change the arguments, use another tool, ` +
    "or give your final answer now."
  );
}

/**
 * @param {string} goal
 * @param {{ workspaceEntries?: string[] }} [options]
 * @returns {Array<{id: string, constraint: string}>}
 */
export function detectTaskHints(goal, options = {}) {
  const text = String(goal ?? "");
  const artifactOnly = isArtifactOnlyGoal(text, options);
  const seen = new Set();
  const hints = [];
  for (const rule of TASK_HINT_RULES) {
    if (artifactOnly && rule.id === "test-fix") continue;
    const matched =
      typeof rule.test === "function" ? rule.test(text) : rule.test?.test?.(text) === true;
    if (matched && !seen.has(rule.id)) {
      seen.add(rule.id);
      hints.push({ id: rule.id, constraint: rule.constraint });
    }
  }
  return hints;
}

/**
 * @param {Array<{id: string, constraint: string}>} hints
 * @returns {string}
 */
export function formatTaskConstraints(hints) {
  if (!hints?.length) return "";
  const lines = hints.map((h) => `- ${h.constraint}`);
  return ["## Task focus", ...lines].join("\n");
}

/**
 * Surface explicit success outcomes inferred from the goal text for the first
 * user turn. Gives the model acceptance criteria before it plans or acts.
 * @param {string} goal
 * @returns {string}
 */
export function formatExplicitGoals(goal) {
  const text = String(goal ?? "").trim();
  if (!text) return "";

  const outcomes = [];
  const hints = detectTaskHints(text);

  for (const file of extractNamedDeliverables(text).filter(isCreatedFileDeliverable)) {
    outcomes.push(`Output artifact exists: \`${file}\``);
  }

  for (const file of extractNamedDeliverables(text).filter((f) => !isCreatedFileDeliverable(f))) {
    outcomes.push(`Deliverable produced or invoked: \`${file}\``);
  }

  for (const file of extractNamedVerifyFiles(text)) {
    outcomes.push(`Named verification runs successfully: \`${file}\``);
  }

  for (const cmd of extractNamedNodeCommands(text)) {
    if (isTestSuiteCommand(cmd) || /\bdotnet\s+run\b/i.test(cmd) || /\bpython3?\s+\S+\.py\b/i.test(cmd)) {
      outcomes.push(`Command exits 0 with expected output: \`${cmd}\``);
    } else if (String(cmd).startsWith("/")) {
      outcomes.push(`Binary/path runs successfully: \`${cmd}\``);
    }
  }

  const smoke = extractSmokeSubcommands(text);
  if (smoke.length) {
    outcomes.push(`Each smoke-test subcommand succeeds: ${smoke.map((s) => `\`${s}\``).join(", ")}`);
  }

  if (hints.some((h) => h.id === "path-answer")) {
    outcomes.push("Final answer is only the requested workspace-relative path or number — no extra text");
  } else if (isSimpleReadAnswerGoal(text)) {
    outcomes.push("Final answer is exactly what the user asked for — no extra text or tools unless reading is required");
  } else if (isQuestionGoal(text) && !goalNeedsSubstantiveTools(text)) {
    outcomes.push("Final answer directly answers the question using tool-grounded facts");
  }

  if (isMergeConflictGoal(text)) {
    outcomes.push("Merge conflict markers removed, changes committed, and named verification passes");
  }

  if (isFollowUpGoal(text)) {
    outcomes.push("Every newly named command or feature is implemented in existing files (not a from-scratch rewrite)");
  }

  if (goalRequiresTestVerify(text) && !outcomes.some((o) => /test|pytest|dotnet\s+run/i.test(o))) {
    outcomes.push("Required test or verify command exits 0 with expected output");
  }

  if (!outcomes.length && shouldPlanGoal(text)) {
    return [
      "## Goals",
      "- Before acting, state 2–5 explicit outcomes that define done for this task",
      "  (deliverables, passing commands, and the shape of the final answer).",
    ].join("\n");
  }

  if (!outcomes.length) return "";

  return ["## Goals (explicit outcomes)", ...outcomes.map((o) => `- ${o}`)].join("\n");
}

/**
 * Whether the first turn should run a planning pre-pass.
 * Word count is not complexity: "create an Electron app" is short and hard.
 * Skip only empty prompts and simple read-and-answer goals, where a plan
 * fights "reply with just the number." `--no-plan` still disables all planning.
 * @param {string} goal
 * @returns {boolean}
 */
export function shouldPlanGoal(goal) {
  const text = String(goal ?? "").trim();
  if (!text) return false;
  if (isSimpleReadAnswerGoal(text)) return false;
  return true;
}

/**
 * @param {string} goal
 * @returns {boolean}
 */
export function isComplexGoal(goal) {
  return shouldPlanGoal(goal);
}

/** GPT-OSS expects think levels, not booleans. */
export function isGptOssModel(model) {
  return /^gpt-oss/i.test(String(model ?? ""));
}

/**
 * Resolve the Ollama `think` request field.
 *
 * @param {object} options
 * @param {boolean|string} [options.think] `auto` (default), `true`/`false`,
 *   or a level (`low`, `medium`, `high`, `max`).
 * @param {boolean|null} [options.thinkingCapable] From model capabilities.
 * @param {string} [options.model]
 * @param {number} [options.paramsB] Model size in billions; smaller models get
 *   stronger thinking when `think` is `auto`.
 * @returns {boolean|string|undefined} Value for the API body, or undefined to omit.
 */
export function resolveThinkSetting({
  think = "auto",
  thinkingCapable,
  model,
  paramsB = 0,
} = {}) {
  if (think === false || think === "false" || think === "off") return undefined;

  const explicitLevel =
    typeof think === "string" && ["low", "medium", "high", "max"].includes(think);
  if (explicitLevel) return think;

  if (thinkingCapable !== true) return undefined;

  const small = paramsB > 0 && paramsB < 14;

  if (think === true || think === "true" || think === "on") {
    return isGptOssModel(model) ? (small ? "high" : "medium") : true;
  }

  // auto — bias harder reasoning for smaller models
  if (isGptOssModel(model)) return small ? "high" : "medium";
  if (small) return true;
  return true;
}

/**
 * Set model metadata on an OllamaClient for think auto-resolution.
 *
 * @param {import("./ollama-client.mjs").OllamaClient} client
 * @param {string} model
 * @param {object} [options]
 * @param {{parameterSize?: string, sizeBytes?: number}} [options.listEntry]
 */
export async function configureClientModel(client, model, { listEntry } = {}) {
  client.model = model;
  const { thinking } = await detectCapabilities(client, model);
  client.thinkingCapable = thinking === true;

  if (listEntry) {
    client.paramsB = parseParamsBillions(listEntry.parameterSize ?? "", listEntry.sizeBytes ?? 0);
    return;
  }
  if (typeof client.listModelsDetailed === "function") {
    try {
      const models = await client.listModelsDetailed();
      const entry = models.find((m) => m.name === model);
      if (entry) {
        client.paramsB = parseParamsBillions(entry.parameterSize ?? "", entry.sizeBytes ?? 0);
      }
    } catch {
      client.paramsB = 0;
    }
  }
}
