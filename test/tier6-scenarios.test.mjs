import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildJudgePrompt } from "../evals/judge.mjs";
import { mergePhaseResults, scenarioPhases } from "../evals/phases.mjs";
import { SCENARIOS, runtimeAvailable, selectScenarios } from "../evals/scenarios.mjs";
import { captureWorkspaceSnapshot } from "../evals/workspace-snapshot.mjs";

/** @param {string} dir @param {Record<string, string>} files */
async function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}

async function checkGolden(name, files) {
  const scenario = SCENARIOS.find((s) => s.name === name);
  assert.ok(scenario, name);
  const dir = await mkdtemp(path.join(os.tmpdir(), `halo-${name}-`));
  try {
    await scenario.setup(dir);
    await writeTree(dir, files);
    const result = await scenario.precheck(dir);
    if (scenario.requires && !runtimeAvailable(scenario.requires === "dotnet" ? "dotnet" : "python")) {
      assert.equal(result.pass, false);
      assert.match(result.detail, new RegExp(scenario.requires === "dotnet" ? "dotnet" : "python", "i"));
    } else {
      assert.equal(result.pass, true, result.detail);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("scenarioPhases is one create step unless followUp is set", () => {
  const single = scenarioPhases({ goal: "build it", maxSteps: 8 }, { maxSteps: 15 });
  assert.deepEqual(single, [{ id: "create", goal: "build it", maxSteps: 8 }]);

  const two = scenarioPhases({
    goal: "create app",
    followUp: "add search",
    maxSteps: 10,
    followUpMaxSteps: 12,
  });
  assert.equal(two.length, 2);
  assert.equal(two[0].id, "create");
  assert.equal(two[1].id, "follow-up");
  assert.equal(two[1].maxSteps, 12);
  assert.match(two[1].goal, /search/);
});

test("mergePhaseResults concatenates steps and keeps the follow-up answer", () => {
  const merged = mergePhaseResults(
    [
      {
        text: "created",
        stopReason: "completed",
        steps: [{ index: 1, kind: "tool-calls", content: "a", toolCalls: [] }],
        messages: [{ role: "user", content: "create" }],
      },
      {
        text: "changed",
        stopReason: "max-steps",
        steps: [{ index: 1, kind: "final", content: "b", toolCalls: [] }],
        messages: [{ role: "user", content: "change" }],
      },
    ],
    [
      { id: "create", goal: "create app" },
      { id: "follow-up", goal: "add search" },
    ],
  );
  assert.equal(merged.text, "changed");
  assert.equal(merged.stopReason, "max-steps");
  assert.equal(merged.steps.length, 2);
  assert.equal(merged.steps[1].index, 2);
  assert.equal(merged.steps[1].phase, 2);
  assert.equal(merged.messages.length, 2);
  assert.equal(merged.phases[0].steps, 1);
  assert.equal(merged.phases[1].id, "follow-up");
});

test("default maxTier 5 excludes tier 6; --tier 6 includes create+follow-up scenarios", () => {
  const upTo5 = selectScenarios({ maxTier: 5 });
  assert.equal(upTo5.some((s) => s.tier === 6), false);
  const upTo6 = selectScenarios({ maxTier: 6 });
  const names = upTo6.filter((s) => s.tier === 6).map((s) => s.name);
  assert.deepEqual(names, [
    "js-library",
    "js-kvstore",
    "py-warehouse",
    "py-flags",
    "cs-tickets",
    "cs-payroll",
  ]);
  for (const scenario of upTo6.filter((s) => s.tier === 6)) {
    assert.ok(scenario.followUp.length > 20);
    assert.equal(typeof scenario.precheck, "function");
  }
});

test("buildJudgePrompt includes both create and follow-up phases", async () => {
  const scenario = SCENARIOS.find((s) => s.name === "js-library");
  const snapshot = await captureWorkspaceSnapshot(process.cwd(), { maxFiles: 2 });
  const prompt = buildJudgePrompt({
    scenario,
    agentResult: { text: "done", stopReason: "completed", steps: [], messages: [] },
    snapshot,
  });
  assert.match(prompt, /Phase 1 — create/);
  assert.match(prompt, /Phase 2 — follow-up change/);
  assert.match(prompt, /search <text>/);
});

test("js-library precheck accepts a correct two-file CLI", async () => {
  await checkGolden("js-library", {
    "books.mjs": [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "const FILE = 'library.json';",
      "export function load() {",
      "  if (!existsSync(FILE)) return { nextId: 1, books: [] };",
      "  return JSON.parse(readFileSync(FILE, 'utf8'));",
      "}",
      "export function save(state) { writeFileSync(FILE, JSON.stringify(state)); }",
      "export function format(b) { return `${b.id}  ${b.title}  copies=${b.copies}  out=${b.out}`; }",
      "",
    ].join("\n"),
    "lib.mjs": [
      "import { format, load, save } from './books.mjs';",
      "function usage() { console.error('usage'); process.exit(1); }",
      "const [cmd, a, b] = process.argv.slice(2);",
      "if (!cmd) usage();",
      "const state = load();",
      "const byId = (id) => state.books.find((x) => x.id === Number(id));",
      "if (cmd === 'add') {",
      "  const copies = Number(b);",
      "  if (!a || !Number.isInteger(copies) || copies < 1) usage();",
      "  const book = { id: state.nextId++, title: a, copies, out: 0 };",
      "  state.books.push(book); save(state); console.log(`added: ${book.id}`);",
      "} else if (cmd === 'list' || cmd === 'search') {",
      "  let books = state.books;",
      "  if (cmd === 'search') {",
      "    if (!a) usage();",
      "    const q = a.toLowerCase();",
      "    books = books.filter((x) => x.title.toLowerCase().includes(q));",
      "  }",
      "  for (const book of books) console.log(format(book));",
      "} else if (cmd === 'checkout' || cmd === 'return') {",
      "  const book = byId(a);",
      "  if (!book) usage();",
      "  if (cmd === 'checkout') {",
      "    if (book.out >= book.copies) { console.log('none'); process.exit(1); }",
      "    book.out++;",
      "  } else {",
      "    if (book.out <= 0) { console.log('none'); process.exit(1); }",
      "    book.out--;",
      "  }",
      "  save(state); console.log(`out: ${book.id} ${book.out}`);",
      "} else if (cmd === 'lost') {",
      "  const book = byId(a);",
      "  if (!book) { console.log('not found'); process.exit(1); }",
      "  book.copies = Math.max(0, book.copies - 1);",
      "  if (book.out > book.copies) book.out = book.copies;",
      "  save(state); console.log(`lost: ${book.id} copies=${book.copies}`);",
      "} else if (cmd === 'stats') {",
      "  console.log(`titles: ${state.books.length}`);",
      "  console.log(`copies: ${state.books.reduce((n, x) => n + x.copies, 0)}`);",
      "  console.log(`out: ${state.books.reduce((n, x) => n + x.out, 0)}`);",
      "} else usage();",
      "",
    ].join("\n"),
    "test.mjs": [
      "import { spawnSync } from 'node:child_process';",
      "import { existsSync, unlinkSync } from 'node:fs';",
      "if (existsSync('library.json')) unlinkSync('library.json');",
      "function run(...args) { return spawnSync(process.execPath, ['lib.mjs', ...args], { encoding: 'utf8' }); }",
      "if (!run('add', 'Dune', '1').stdout.includes('added: 1')) process.exit(1);",
      "if (!run('checkout', '1').stdout.includes('out: 1 1')) process.exit(1);",
      "if (run('checkout', '1').status === 0) process.exit(1);",
      "if (!run('stats').stdout.includes('titles: 1')) process.exit(1);",
      "console.log('ok');",
      "",
    ].join("\n"),
  });
});

test("js-kvstore precheck accepts a correct two-file CLI", async () => {
  await checkGolden("js-kvstore", {
    "store.mjs": [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "const FILE = 'kv.json';",
      "export function load() { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}; }",
      "export function save(data) { writeFileSync(FILE, JSON.stringify(data)); }",
      "",
    ].join("\n"),
    "kv.mjs": [
      "import { load, save } from './store.mjs';",
      "function usage() { console.error('usage'); process.exit(1); }",
      "const [cmd, ...rest] = process.argv.slice(2);",
      "if (!cmd) usage();",
      "const data = load();",
      "if (cmd === 'set') {",
      "  const [key, value] = rest;",
      "  if (!key || value == null) usage();",
      "  data[key] = String(value); save(data); console.log(`set: ${key}`);",
      "} else if (cmd === 'get') {",
      "  if (!rest[0] || !(rest[0] in data)) { console.log('not found'); process.exit(1); }",
      "  console.log(data[rest[0]]);",
      "} else if (cmd === 'list') {",
      "  for (const key of Object.keys(data).sort()) console.log(key);",
      "} else if (cmd === 'delete') {",
      "  if (!rest[0] || !(rest[0] in data)) { console.log('not found'); process.exit(1); }",
      "  delete data[rest[0]]; save(data); console.log(`deleted: ${rest[0]}`);",
      "} else if (cmd === 'incr') {",
      "  const key = rest[0]; if (!key) usage();",
      "  const raw = key in data ? String(data[key]) : '0';",
      "  if (!/^-?\\d+$/.test(raw)) usage();",
      "  const n = Number(raw) + 1; data[key] = String(n); save(data); console.log(`value: ${n}`);",
      "} else if (cmd === 'mget') {",
      "  if (!rest.length) usage();",
      "  for (const key of rest) console.log(`${key}=${key in data ? data[key] : ''}`);",
      "} else if (cmd === 'dump') {",
      "  console.log(JSON.stringify(data));",
      "} else usage();",
      "",
    ].join("\n"),
    "test.mjs": [
      "import { spawnSync } from 'node:child_process';",
      "import { existsSync, unlinkSync } from 'node:fs';",
      "if (existsSync('kv.json')) unlinkSync('kv.json');",
      "function run(...args) { return spawnSync(process.execPath, ['kv.mjs', ...args], { encoding: 'utf8' }); }",
      "if (!run('set', 'a', '1').stdout.includes('set: a')) process.exit(1);",
      "if (run('get', 'a').stdout.trim() !== '1') process.exit(1);",
      "if (!run('incr', 'n').stdout.includes('value: 1')) process.exit(1);",
      "if (!run('delete', 'a').stdout.includes('deleted: a')) process.exit(1);",
      "console.log('ok');",
      "",
    ].join("\n"),
  });
});

test("py-warehouse precheck accepts a correct two-file CLI", async () => {
  await checkGolden("py-warehouse", {
    "stock.py": [
      "import json, os",
      "FILE = 'stock.json'",
      "def load():",
      "    if not os.path.exists(FILE):",
      "        return {}",
      "    with open(FILE, encoding='utf-8') as f:",
      "        return json.load(f)",
      "def save(state):",
      "    with open(FILE, 'w', encoding='utf-8') as f:",
      "        json.dump(state, f)",
      "def total(item):",
      "    return sum(lot['qty'] for lot in item.get('lots', []))",
      "",
    ].join("\n"),
    "warehouse.py": [
      "import sys",
      "from stock import load, save, total",
      "def usage():",
      "    print('usage', file=sys.stderr)",
      "    sys.exit(1)",
      "args = sys.argv[1:]",
      "if not args: usage()",
      "cmd, rest = args[0], args[1:]",
      "state = load()",
      "try:",
      "    if cmd == 'receive':",
      "        sku, qty = rest[0], int(rest[1])",
      "        if qty <= 0: usage()",
      "        lot = rest[rest.index('--lot') + 1] if '--lot' in rest else 'default'",
      "        item = state.setdefault(sku, {'lots': []})",
      "        found = next((row for row in item['lots'] if row['id'] == lot), None)",
      "        if found: found['qty'] += qty",
      "        else: item['lots'].append({'id': lot, 'qty': qty})",
      "        save(state)",
      "        print(f'stock: {sku} {total(item)}')",
      "    elif cmd == 'ship':",
      "        sku, qty = rest[0], int(rest[1])",
      "        if qty <= 0: usage()",
      "        item = state.get(sku, {'lots': []})",
      "        if total(item) < qty:",
      "            print('short')",
      "            sys.exit(1)",
      "        left = qty",
      "        for lot in item['lots']:",
      "            take = min(lot['qty'], left)",
      "            lot['qty'] -= take",
      "            left -= take",
      "        item['lots'] = [lot for lot in item['lots'] if lot['qty'] > 0]",
      "        state[sku] = item",
      "        save(state)",
      "        print(f'stock: {sku} {total(item)}')",
      "    elif cmd == 'stock':",
      "        sku = rest[0]",
      "        print(f\"stock: {sku} {total(state.get(sku, {'lots': []}))}\")",
      "    elif cmd == 'skus':",
      "        for sku in sorted(state):",
      "            print(sku)",
      "    elif cmd == 'lots':",
      "        sku = rest[0]",
      "        for lot in state.get(sku, {'lots': []}).get('lots', []):",
      "            if lot['qty'] > 0:",
      "                print(f\"{lot['id']}  qty={lot['qty']}\")",
      "    else:",
      "        usage()",
      "except (IndexError, ValueError):",
      "    usage()",
      "",
    ].join("\n"),
    "test.py": [
      "import os, subprocess, sys",
      "if os.path.exists('stock.json'): os.remove('stock.json')",
      "def run(*args):",
      "    return subprocess.run([sys.executable, 'warehouse.py', *args], capture_output=True, text=True)",
      "assert 'stock: BOLT 5' in run('receive', 'BOLT', '5').stdout",
      "assert run('ship', 'BOLT', '9').returncode != 0",
      "assert 'short' in run('ship', 'BOLT', '9').stdout",
      "print('ok')",
      "",
    ].join("\n"),
  });
});

test("py-flags precheck accepts a correct two-file CLI", async () => {
  await checkGolden("py-flags", {
    "flagstore.py": [
      "import hashlib, json, os",
      "FILE = 'flags.json'",
      "def load():",
      "    if not os.path.exists(FILE):",
      "        return {}",
      "    with open(FILE, encoding='utf-8') as f:",
      "        return json.load(f)",
      "def save(state):",
      "    with open(FILE, 'w', encoding='utf-8') as f:",
      "        json.dump(state, f)",
      "def bucket(name, actor):",
      "    digest = hashlib.md5(f'{name}:{actor}'.encode('utf-8')).hexdigest()[:8]",
      "    return int(digest, 16) % 100",
      "def label(percent):",
      "    if percent == 100: return 'on'",
      "    if percent == 0: return 'off'",
      "    return f'percent={percent}'",
      "",
    ].join("\n"),
    "flags.py": [
      "import sys",
      "from flagstore import bucket, label, load, save",
      "def usage():",
      "    print('usage', file=sys.stderr)",
      "    sys.exit(1)",
      "args = sys.argv[1:]",
      "if not args: usage()",
      "cmd, rest = args[0], args[1:]",
      "state = load()",
      "try:",
      "    if cmd == 'set':",
      "        name = rest[0]",
      "        if '--percent' in rest:",
      "            percent = int(rest[rest.index('--percent') + 1])",
      "        elif rest[1] == 'on':",
      "            percent = 100",
      "        elif rest[1] == 'off':",
      "            percent = 0",
      "        else:",
      "            usage()",
      "        if percent < 0 or percent > 100: usage()",
      "        state[name] = percent",
      "        save(state)",
      "        shown = 'on' if percent == 100 else 'off' if percent == 0 else str(percent)",
      "        if percent in (0, 100):",
      "            print(f'set: {name} {shown}')",
      "        else:",
      "            print(f'set: {name} percent={percent}')",
      "    elif cmd == 'get':",
      "        name = rest[0]",
      "        if name not in state:",
      "            print('not found')",
      "            sys.exit(1)",
      "        percent = state[name]",
      "        print('on' if percent == 100 else 'off' if percent == 0 else f'percent: {percent}')",
      "    elif cmd == 'list':",
      "        for name in sorted(state):",
      "            print(f'{name}  {label(state[name])}')",
      "    elif cmd == 'eval':",
      "        name, actor = rest[0], rest[1]",
      "        if name not in state:",
      "            print('not found')",
      "            sys.exit(1)",
      "        print('on' if bucket(name, actor) < state[name] else 'off')",
      "    else:",
      "        usage()",
      "except (IndexError, ValueError, KeyError):",
      "    usage()",
      "",
    ].join("\n"),
    "test.py": [
      "import os, subprocess, sys",
      "if os.path.exists('flags.json'): os.remove('flags.json')",
      "def run(*args):",
      "    return subprocess.run([sys.executable, 'flags.py', *args], capture_output=True, text=True)",
      "assert 'set: dark on' in run('set', 'dark', 'on').stdout",
      "assert run('get', 'dark').stdout.strip() == 'on'",
      "assert run('eval', 'missing', 'ada').returncode != 0",
      "print('ok')",
      "",
    ].join("\n"),
  });
});

test("cs-tickets precheck compiles and checks CLI output", { timeout: 120_000 }, async () => {
  await checkGolden("cs-tickets", {
    "Tickets.cs": [
      "using System.Text.Json;",
      "public sealed record Ticket(int Id, string Status, string Title, string Priority, string Who);",
      "public sealed class Board {",
      "  public int NextId { get; set; } = 1;",
      "  public List<Ticket> Tickets { get; set; } = new();",
      "  public static Board Load(string path) {",
      "    if (!File.Exists(path)) return new Board();",
      "    using var doc = JsonDocument.Parse(File.ReadAllText(path));",
      "    var board = new Board { NextId = doc.RootElement.GetProperty(\"nextId\").GetInt32() };",
      "    foreach (var el in doc.RootElement.GetProperty(\"tickets\").EnumerateArray()) {",
      "      board.Tickets.Add(new Ticket(",
      "        el.GetProperty(\"id\").GetInt32(),",
      "        el.GetProperty(\"status\").GetString()!,",
      "        el.GetProperty(\"title\").GetString()!,",
      "        el.GetProperty(\"priority\").GetString()!,",
      "        el.GetProperty(\"who\").GetString()!));",
      "    }",
      "    return board;",
      "  }",
      "  public void Save(string path) {",
      "    var payload = new { nextId = NextId, tickets = Tickets.Select(t => new { id = t.Id, status = t.Status, title = t.Title, priority = t.Priority, who = t.Who }) };",
      "    File.WriteAllText(path, JsonSerializer.Serialize(payload));",
      "  }",
      "}",
      "",
    ].join("\n"),
    "Program.cs": [
      "var store = \"tickets.json\";",
      "var board = Board.Load(store);",
      "if (args.Length == 0) Usage();",
      "switch (args[0]) {",
      "  case \"open\":",
      "    if (args.Length < 2) Usage();",
      "    board.Tickets.Add(new Ticket(board.NextId, \"open\", args[1], \"normal\", \"-\"));",
      "    Console.WriteLine($\"opened: {board.NextId}\");",
      "    board.NextId++;",
      "    board.Save(store);",
      "    break;",
      "  case \"list\":",
      "    foreach (var t in board.Tickets.OrderBy(t => t.Id)) Console.WriteLine($\"{t.Id}  {t.Status}  {t.Title}\");",
      "    break;",
      "  case \"close\": {",
      "    if (args.Length < 2) Usage();",
      "    int id;",
      "    if (!int.TryParse(args[1], out id)) Usage();",
      "    var idx = board.Tickets.FindIndex(t => t.Id == id);",
      "    if (idx < 0) { Console.WriteLine(\"not found\"); Environment.Exit(1); }",
      "    board.Tickets[idx] = board.Tickets[idx] with { Status = \"closed\" };",
      "    board.Save(store);",
      "    Console.WriteLine($\"closed: {id}\");",
      "    break;",
      "  }",
      "  case \"assign\": {",
      "    if (args.Length < 3) Usage();",
      "    int id;",
      "    if (!int.TryParse(args[1], out id)) Usage();",
      "    var idx = board.Tickets.FindIndex(t => t.Id == id);",
      "    if (idx < 0) { Console.WriteLine(\"not found\"); Environment.Exit(1); }",
      "    board.Tickets[idx] = board.Tickets[idx] with { Who = args[2] };",
      "    board.Save(store);",
      "    Console.WriteLine($\"assigned: {id} {args[2]}\");",
      "    break;",
      "  }",
      "  case \"priority\": {",
      "    if (args.Length < 3) Usage();",
      "    int id;",
      "    if (!int.TryParse(args[1], out id)) Usage();",
      "    var level = args[2];",
      "    if (level != \"low\" && level != \"normal\" && level != \"high\") Usage();",
      "    var idx = board.Tickets.FindIndex(t => t.Id == id);",
      "    if (idx < 0) { Console.WriteLine(\"not found\"); Environment.Exit(1); }",
      "    board.Tickets[idx] = board.Tickets[idx] with { Priority = level };",
      "    board.Save(store);",
      "    Console.WriteLine($\"priority: {id} {level}\");",
      "    break;",
      "  }",
      "  case \"board\":",
      "    foreach (var t in board.Tickets.OrderBy(t => t.Id)) Console.WriteLine($\"{t.Id}  {t.Status}  {t.Priority}  {t.Who}  {t.Title}\");",
      "    break;",
      "  case \"mine\":",
      "    if (args.Length < 2) Usage();",
      "    foreach (var t in board.Tickets.Where(t => t.Who == args[1]).OrderBy(t => t.Id))",
      "      Console.WriteLine($\"{t.Id}  {t.Status}  {t.Title}\");",
      "    break;",
      "  default:",
      "    Usage();",
      "    break;",
      "}",
      "void Usage() { Console.WriteLine(\"usage: open|list|close|assign|priority|board|mine\"); Environment.Exit(1); }",
      "",
    ].join("\n"),
  });
});

test("cs-payroll precheck compiles and checks CLI output", { timeout: 120_000 }, async () => {
  await checkGolden("cs-payroll", {
    "Payroll.cs": [
      "using System.Text.Json;",
      "public sealed class Employee {",
      "  public string Name { get; set; } = \"\";",
      "  public int Rate { get; set; }",
      "  public int Hours { get; set; }",
      "  public int Bonus { get; set; }",
      "  public int Pay => Hours * Rate + Math.Max(0, Hours - 40) * Rate / 2 + Bonus;",
      "}",
      "public sealed class Ledger {",
      "  public List<Employee> People { get; set; } = new();",
      "  public static Ledger Load(string path) {",
      "    if (!File.Exists(path)) return new Ledger();",
      "    using var doc = JsonDocument.Parse(File.ReadAllText(path));",
      "    var ledger = new Ledger();",
      "    foreach (var el in doc.RootElement.GetProperty(\"people\").EnumerateArray()) {",
      "      ledger.People.Add(new Employee {",
      "        Name = el.GetProperty(\"name\").GetString()!,",
      "        Rate = el.GetProperty(\"rate\").GetInt32(),",
      "        Hours = el.GetProperty(\"hours\").GetInt32(),",
      "        Bonus = el.GetProperty(\"bonus\").GetInt32()",
      "      });",
      "    }",
      "    return ledger;",
      "  }",
      "  public void Save(string path) {",
      "    var payload = new { people = People.Select(p => new { name = p.Name, rate = p.Rate, hours = p.Hours, bonus = p.Bonus }) };",
      "    File.WriteAllText(path, JsonSerializer.Serialize(payload));",
      "  }",
      "  public Employee? Find(string name) => People.Find(p => p.Name == name);",
      "}",
      "",
    ].join("\n"),
    "Program.cs": [
      "var store = \"payroll.json\";",
      "var ledger = Ledger.Load(store);",
      "if (args.Length == 0) Usage();",
      "switch (args[0]) {",
      "  case \"hire\": {",
      "    if (args.Length < 3) Usage();",
      "    int rate;",
      "    if (!int.TryParse(args[2], out rate)) Usage();",
      "    if (ledger.Find(args[1]) is not null) Environment.Exit(1);",
      "    ledger.People.Add(new Employee { Name = args[1], Rate = rate });",
      "    ledger.Save(store);",
      "    Console.WriteLine($\"hired: {args[1]}\");",
      "    break;",
      "  }",
      "  case \"hours\": {",
      "    if (args.Length < 3) Usage();",
      "    int n;",
      "    if (!int.TryParse(args[2], out n) || n <= 0) Usage();",
      "    var person = ledger.Find(args[1]);",
      "    if (person is null) { Console.WriteLine(\"not found\"); Environment.Exit(1); }",
      "    person.Hours += n;",
      "    ledger.Save(store);",
      "    Console.WriteLine($\"logged: {person.Name} {person.Hours}\");",
      "    break;",
      "  }",
      "  case \"pay\": {",
      "    if (args.Length < 2) Usage();",
      "    var person = ledger.Find(args[1]);",
      "    if (person is null) { Console.WriteLine(\"not found\"); Environment.Exit(1); }",
      "    Console.WriteLine($\"pay: {person.Name} {person.Pay}\");",
      "    break;",
      "  }",
      "  case \"bonus\": {",
      "    if (args.Length < 3) Usage();",
      "    int n;",
      "    if (!int.TryParse(args[2], out n) || n <= 0) Usage();",
      "    var person = ledger.Find(args[1]);",
      "    if (person is null) { Console.WriteLine(\"not found\"); Environment.Exit(1); }",
      "    person.Bonus += n;",
      "    ledger.Save(store);",
      "    Console.WriteLine($\"bonus: {person.Name} {n}\");",
      "    break;",
      "  }",
      "  case \"clear\": {",
      "    if (args.Length < 2) Usage();",
      "    var person = ledger.Find(args[1]);",
      "    if (person is null) { Console.WriteLine(\"not found\"); Environment.Exit(1); }",
      "    person.Hours = 0;",
      "    person.Bonus = 0;",
      "    ledger.Save(store);",
      "    Console.WriteLine($\"cleared: {person.Name}\");",
      "    break;",
      "  }",
      "  case \"roster\":",
      "    foreach (var person in ledger.People.OrderBy(p => p.Name, StringComparer.Ordinal)) Console.WriteLine(person.Name);",
      "    break;",
      "  default:",
      "    Usage();",
      "    break;",
      "}",
      "void Usage() { Console.WriteLine(\"usage: hire|hours|pay|bonus|clear|roster\"); Environment.Exit(1); }",
      "",
    ].join("\n"),
  });
});
