import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function rpc(cwd, home, agent, genome, profiles, extra = []) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "COMSPEC", "ProgramFiles", "ProgramFiles(x86)"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", RSIH_CODING_AGENT_DIR: agent });
  const child = spawn(process.execPath, [join(repo, "src", "cli.ts"), "--mode", "rpc", "--offline",
    "--cwd", cwd, ...(genome ? ["--genome", genome] : []), "--config", profiles, ...extra],
    { cwd, env, stdio: "pipe", windowsHide: true });
  const pending = new Map();
  let serial = 0;
  let stderr = "";
  const reader = createInterface({ input: child.stdout });
  child.stderr.on("data", chunk => { stderr += chunk; });
  reader.on("line", line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type !== "response" || !pending.has(event.id)) return;
    const { resolve, reject, timer } = pending.get(event.id);
    pending.delete(event.id);
    clearTimeout(timer);
    if (event.success) resolve(event.data ?? event);
    else reject(new Error(JSON.stringify(event)));
  });
  child.on("exit", code => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`CLI exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  return {
    request(command) {
      return new Promise((resolve, reject) => {
        const id = String(++serial);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timed out: ${JSON.stringify(command)} ${stderr}`));
        }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await exited;
      reader.close();
    },
  };
}

test("two live CLI sessions keep their Genome settings through reload and switching", { timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "rsih-isolation-"));
  const agent = join(root, "agent");
  const aCwd = join(root, "project-a");
  const bCwd = join(root, "project-b");
  for (const path of [agent, aCwd, bCwd]) mkdirSync(path, { recursive: true });
  const shared = join(agent, "settings.json");
  writeFileSync(shared, JSON.stringify({ theme: "dark" }));
  const auth = JSON.stringify({ "synthetic-unused": { type: "api_key", key: "SYNTHETIC_TEST_VALUE" } });
  writeFileSync(join(agent, "auth.json"), auth);
  const models = JSON.stringify({ providers: {} });
  writeFileSync(join(agent, "models.json"), models);
  mkdirSync(join(agent, "skills", "shared-workflow"), { recursive: true });
  writeFileSync(join(agent, "skills", "shared-workflow", "SKILL.md"),
    "---\nname: shared-workflow\ndescription: A synthetic shared user skill.\n---\nRead local files.\n");
  mkdirSync(join(agent, "prompts"));
  writeFileSync(join(agent, "prompts", "shared-greeting.md"), "Say hello.\n");
  const profiles = join(root, "profiles.json");
  writeFileSync(profiles, JSON.stringify({ mock: { kind: "mock", model: "isolation-model", mock_responses: ["ok"] } }));
  const observer = join(root, "observer.ts");
  writeFileSync(observer, `export default function(pi) {
    pi.registerCommand("audit-reload", { description: "Reload without a model call", async handler(_args, ctx) { await ctx.reload(); } });
  }`);
  const makeGenome = (name, mode) => {
    const path = join(root, `${name}.json`);
    writeFileSync(path, JSON.stringify({ genome_schema_version: "2", genome_id: `harness:${name}`, version: 1,
      model: { profile: "mock", id: "isolation-model" }, extensions: [observer],
      runtime: { steering_mode: mode, follow_up_mode: mode } }));
    return path;
  };
  const genomeA = makeGenome("a", "one-at-a-time");
  const genomeB = makeGenome("b", "all");
  const a = rpc(aCwd, root, agent, genomeA, profiles);
  let b;
  t.after(async () => {
    await Promise.all([a.close(), b?.close()]);
    rmSync(root, { recursive: true, force: true });
  });
  const initialA = await a.request({ type: "get_state" });
  assert.equal(initialA.steeringMode, "one-at-a-time");
  b = rpc(bCwd, root, agent, genomeB, profiles);
  const initialB = await b.request({ type: "get_state" });
  assert.equal(initialB.steeringMode, "all");
  assert.notEqual(initialA.sessionId, initialB.sessionId);
  assert.ok(initialA.sessionFile.startsWith(join(agent, "sessions")));
  assert.ok(initialB.sessionFile.startsWith(join(agent, "sessions")));

  await a.request({ type: "prompt", message: "/audit-reload" });
  const reloaded = await a.request({ type: "get_state" });
  assert.equal(reloaded.steeringMode, "one-at-a-time");
  assert.equal(reloaded.followUpMode, "one-at-a-time");
  assert.equal(reloaded.sessionId, initialA.sessionId);
  assert.equal((await b.request({ type: "get_state" })).steeringMode, "all");

  const commands = await a.request({ type: "get_commands" });
  const names = (commands.commands ?? commands).map(command => command.name);
  assert.ok(names.includes("shared-greeting"), "global prompt discovery is unchanged");
  assert.ok(names.includes("skill:shared-workflow"), "global skill discovery is unchanged");
  await b.request({ type: "set_auto_compaction", enabled: false });
  // Settings persistence is queued by Pi; the reload waits for that queue.
  await b.request({ type: "prompt", message: "/audit-reload" });
  const stored = JSON.parse(readFileSync(shared, "utf8"));
  assert.equal(stored.compaction.enabled, false);
  assert.equal(stored.steeringMode, undefined);
  assert.equal(stored.followUpMode, undefined);
  assert.equal(stored.quietStartup, undefined);
  assert.equal(stored.$rsih, undefined);
  assert.equal(readFileSync(join(agent, "auth.json"), "utf8"), auth);
  assert.equal(readFileSync(join(agent, "models.json"), "utf8"), models);

  await a.request({ type: "prompt", message: `/switch-genome ${genomeB}` });
  assert.equal((await a.request({ type: "get_state" })).steeringMode, "all");
  await a.request({ type: "prompt", message: `/switch-genome ${genomeA}` });
  assert.equal((await a.request({ type: "get_state" })).steeringMode, "one-at-a-time");
  assert.equal((await b.request({ type: "get_state" })).steeringMode, "all");
  // One mock completion proves ordinary session persistence still uses shared history.
  await a.request({ type: "prompt", message: "Synthetic persistence check." });
  let final;
  for (let attempt = 0; attempt < 100; attempt++) {
    final = await a.request({ type: "get_state" });
    if (!final.isStreaming && final.messageCount >= 2) break;
    await delay(20);
  }
  assert.ok(final.messageCount >= 2);
  assert.match(readFileSync(final.sessionFile, "utf8"), /Synthetic persistence check/);
});


test("two concurrent sessions in one workspace keep independent Genome overlays", { timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "rsih-same-workspace-"));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agent, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const profiles = join(root, "providers.json");
  writeFileSync(profiles, JSON.stringify({
    mock: { kind: "mock", model: "shared-test-model", mock_responses: ["ok"] },
  }));
  const makeGenome = (name, mode) => {
    const path = join(root, name + ".json");
    writeFileSync(path, JSON.stringify({
      genome_schema_version: "2", genome_id: "harness:" + name, version: 1,
      model: { profile: "mock", id: "shared-test-model" },
      runtime: { steering_mode: mode, follow_up_mode: mode },
    }));
    return path;
  };
  const a = rpc(cwd, root, agent, makeGenome("a", "all"), profiles);
  const b = rpc(cwd, root, agent, makeGenome("b", "one-at-a-time"), profiles);
  t.after(async () => {
    await Promise.all([a.close(), b.close()]);
    rmSync(root, { recursive: true, force: true });
  });
  const [left, right] = await Promise.all([
    a.request({ type: "get_state" }),
    b.request({ type: "get_state" }),
  ]);
  assert.equal(left.steeringMode, "all");
  assert.equal(right.steeringMode, "one-at-a-time");
  assert.notEqual(left.sessionId, right.sessionId);
  assert.notEqual(left.sessionFile, right.sessionFile);
  assert.equal((await a.request({ type: "get_state" })).steeringMode, "all");
  assert.equal((await b.request({ type: "get_state" })).steeringMode, "one-at-a-time");
});

async function complete(client, message) {
  const before = await client.request({ type: "get_state" });
  await client.request({ type: "prompt", message });
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await client.request({ type: "get_state" });
    if (!state.isStreaming && state.messageCount >= before.messageCount + 2) return state;
    await delay(20);
  }
  assert.fail("The synthetic completion did not finish");
}

test("plain RPC sessions resume across projects with the target project's settings", { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "rsih-default-resume-"));
  const agent = join(root, "agent");
  const projects = [join(root, "a"), join(root, "b")];
  for (const project of projects) mkdirSync(join(project, ".rsih", "genomes"), { recursive: true });
  writeFileSync(join(projects[0], ".rsih", "settings.json"), JSON.stringify({ followUpMode: "all" }));
  writeFileSync(join(projects[1], ".rsih", "settings.json"), JSON.stringify({ followUpMode: "one-at-a-time" }));
  for (const [index, project] of projects.entries()) {
    writeFileSync(join(project, ".rsih", "genomes", "local.json"), JSON.stringify({
      genome_schema_version: "2",
      genome_id: `harness:local-project-${index}`,
      version: 1,
      model: { profile: "mock", id: "audit" },
      runtime: { steering_mode: index === 0 ? "one-at-a-time" : "all" },
    }));
  }
  const profiles = join(root, "providers.json");
  writeFileSync(profiles, JSON.stringify({ mock: { kind: "mock", model: "audit", mock_responses: ["ok"] } }));
  const target = rpc(projects[1], root, agent, undefined, profiles, ["--profile", "mock", "--approve"]);
  let source;
  t.after(async () => {
    await Promise.all([target.close(), source?.close()]);
    rmSync(root, { recursive: true, force: true });
  });
  const saved = await complete(target, "Project B.");
  await target.close();
  source = rpc(projects[0], root, agent, undefined, profiles, ["--profile", "mock", "--approve"]);
  const before = await source.request({ type: "get_state" });
  assert.equal(before.followUpMode, "all");
  const result = await source.request({ type: "switch_session", sessionPath: saved.sessionFile });
  assert.equal(result.cancelled, false);
  const after = await source.request({ type: "get_state" });
  assert.notEqual(after.sessionId, before.sessionId);
  assert.equal(after.sessionId, saved.sessionId);
  assert.equal(after.followUpMode, "one-at-a-time");
  await complete(source, "Continue project B.");
  assert.match(readFileSync(saved.sessionFile, "utf8"), /Continue project B/);
  await source.request({ type: "prompt", message: "/switch-genome local" });
  assert.equal((await source.request({ type: "get_state" })).steeringMode, "all");
});

test("same-id Genome versions can switch and restore frozen history without adopting disk edits", { timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "rsih-version-tree-"));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const profiles = join(root, "providers.json");
  writeFileSync(profiles, JSON.stringify({ mock: { kind: "mock", model: "audit", mock_responses: ["ok"] } }));
  const observer = join(root, "observer.ts");
  const treeResult = join(root, "tree.json");
  const promptResult = join(root, "prompt.txt");
  writeFileSync(observer, `import { writeFileSync } from "node:fs";
export default function(pi) {
  pi.registerCommand("audit-tree", { description: "Synthetic tree audit", async handler(args, ctx) {
    const result = await ctx.navigateTree(args.trim(), { summarize: false });
    writeFileSync(${JSON.stringify(treeResult)}, JSON.stringify(result));
  } });
  pi.on("agent_start", (_event, ctx) => { writeFileSync(${JSON.stringify(promptResult)}, ctx.getSystemPrompt()); });
}`);
  const manifest = join(root, "genome.json");
  const writeGenome = (mode, prompt) => writeFileSync(manifest, JSON.stringify({
    genome_schema_version: "2", genome_id: "harness:version-tree", version: 1,
    model: { profile: "mock", id: "audit" }, extensions: [observer],
    settings: { steeringMode: mode }, append_system_prompt: prompt,
  }));
  writeGenome("one-at-a-time", "FROZEN_FIRST");
  const client = rpc(cwd, root, agent, manifest, profiles);
  let resumed;
  t.after(async () => {
    await Promise.all([client.close(), resumed?.close()]);
    rmSync(root, { recursive: true, force: true });
  });
  const first = await complete(client, "First version.");
  const entries = () => readFileSync(first.sessionFile, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  const firstLeaf = entries().at(-1).id;
  writeGenome("all", "FROZEN_SECOND");
  await client.request({ type: "prompt", message: `/switch-genome ${manifest}` });
  assert.equal((await client.request({ type: "get_state" })).steeringMode, "all");
  await complete(client, "Second version.");
  const secondLeaf = entries().at(-1).id;
  await client.close();
  // A later unadopted edit must not influence either historical branch.
  writeGenome("all", "UNADOPTED_DISK_EDIT");
  resumed = rpc(cwd, root, agent, undefined, profiles, ["--session", first.sessionFile]);
  await resumed.request({ type: "prompt", message: `/audit-tree ${firstLeaf}` });
  assert.equal(JSON.parse(readFileSync(treeResult, "utf8")).cancelled, false);
  assert.equal((await resumed.request({ type: "get_state" })).steeringMode, "one-at-a-time");
  await complete(resumed, "Continue first branch.");
  assert.match(readFileSync(promptResult, "utf8"), /FROZEN_FIRST/);
  assert.doesNotMatch(readFileSync(promptResult, "utf8"), /FROZEN_SECOND|UNADOPTED_DISK_EDIT/);
  await resumed.request({ type: "prompt", message: `/audit-tree ${secondLeaf}` });
  assert.equal(JSON.parse(readFileSync(treeResult, "utf8")).cancelled, false);
  assert.equal((await resumed.request({ type: "get_state" })).steeringMode, "all");
  await complete(resumed, "Continue second branch.");
  assert.match(readFileSync(promptResult, "utf8"), /FROZEN_SECOND/);
  assert.doesNotMatch(readFileSync(promptResult, "utf8"), /FROZEN_FIRST|UNADOPTED_DISK_EDIT/);
  assert.equal(entries().filter(entry => entry.customType === "rsih.configuration").length, 2);
});
