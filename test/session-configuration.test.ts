import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createConfigurationSnapshot, findLatestSnapshot } from "../src/harness/configuration-snapshot.ts";
import { latestSessionGenome, sessionBranchEntries, sessionForkBranchEntries, sessionGenomeChanged, sessionNeedsRestore } from "../src/harness/session-configuration.ts";
import { createDefaultHarnessGenome } from "../src/harness/genome.ts";
import { createGenomeSession, startupPromptRecord } from "../src/harness/genome-session.ts";
import { createRuntimeSettings } from "../src/harness/runtime-settings.ts";
import { createGenomeExtension, genomeActivation } from "../src/pi-cli-runtime.ts";
import { SUPERVISED_ENV, takeSwitchRequest } from "../src/cli/supervisor.ts";

function snapshot(settings) {
  return createConfigurationSnapshot(settings, {}, { genome: "demo", rsih: "0.1.0" });
}

test("the empty default Genome is identical across project directories", () => {
  const genome = createDefaultHarnessGenome();
  assert.equal(sessionGenomeChanged({ reference: "default", baseDirectory: "/a", genome },
    { reference: "default", baseDirectory: "/b", genome }), false);
  const custom = { ...genome, extensions: ["./extension.ts"] };
  assert.equal(sessionGenomeChanged({ reference: "default", baseDirectory: "/a", genome: custom },
    { reference: "default", baseDirectory: "/b", genome: custom }), true,
    "a Genome with relative resources must still distinguish resource roots");
});

test("session snapshots only follow the active branch, not an unrelated later branch", () => {
  const a = snapshot({ steeringMode: "one-at-a-time" });
  const b = snapshot({ steeringMode: "all" });
  const entries = [
    { type: "session", id: "session-id" },
    { type: "custom", id: "root", parentId: null, customType: "rsih.configuration", data: a },
    { type: "message", id: "a1", parentId: "root" },
    { type: "custom", id: "b1", parentId: "root", customType: "rsih.configuration", data: b },
    { type: "message", id: "b2", parentId: "b1" },
    { type: "message", id: "a2", parentId: "a1" },
  ];
  const branchA = sessionBranchEntries(entries);
  assert.deepEqual(branchA.map(entry => entry.id), ["root", "a1", "a2"]);
  assert.equal(findLatestSnapshot(branchA)?.settings.steeringMode, "one-at-a-time");
  const branchB = sessionBranchEntries(entries, "b2");
  assert.deepEqual(branchB.map(entry => entry.id), ["root", "b1", "b2"]);
  assert.equal(findLatestSnapshot(branchB)?.settings.steeringMode, "all");
});

test("frozen Genome lookup follows session branches and detects content updates", () => {
  const original = { genome_id: "harness:demo", version: 1, settings: { steeringMode: "all" } };
  const updated = { ...original, settings: { steeringMode: "one-at-a-time" } };
  const entries = [
    { type: "custom", id: "root", parentId: null, customType: "rsih.genome",
      data: { reference: "demo", baseDirectory: "/genomes", genome: original } },
    { type: "custom", id: "other", parentId: "root", customType: "rsih.genome",
      data: { reference: "demo", baseDirectory: "/genomes", genome: updated } },
    { type: "message", id: "active", parentId: "root" },
  ];
  const target = latestSessionGenome(sessionBranchEntries(entries));
  assert.equal(target.genome.settings.steeringMode, "all");
  const current = { reference: "demo", baseDirectory: "/genomes", genome: original };
  assert.equal(sessionGenomeChanged(current, target), false);
  assert.equal(sessionGenomeChanged({ ...current, genome: updated }, target), true);
  assert.equal(sessionGenomeChanged({ ...current, reference: "other" }, target), true);
  assert.equal(sessionGenomeChanged({ ...current, baseDirectory: "/different" }, target), true);
  assert.equal(sessionGenomeChanged(current, undefined), false);
});

test("empty/legacy session without an active tree does not invent a snapshot", () => {
  assert.deepEqual(sessionBranchEntries([]), []);
  assert.deepEqual(sessionBranchEntries([{ type: "session", id: "header" }]), []);
  assert.deepEqual(sessionBranchEntries([{ type: "message", id: "entry", parentId: null }], null), []);
});

test("startup --resume reopens a session whose saved Genome or settings differ", () => {
  const genome = { genome_id: "harness:demo", settings: { steeringMode: "all" } };
  const current = { reference: "demo", baseDirectory: "/same", genome };
  const target = { reference: "demo", baseDirectory: "/same", genome };
  const settings = { settings: { steeringMode: "all" }, keybindings: {} };
  const saved = snapshot({ steeringMode: "one-at-a-time" });
  assert.equal(sessionNeedsRestore(current, target, settings, saved), true);
  assert.equal(sessionNeedsRestore(current, target, settings, snapshot(settings.settings)), false);
  assert.equal(sessionNeedsRestore(current, { ...target, reference: "other" }, settings, undefined), true);
  assert.equal(sessionNeedsRestore(current, target, settings, undefined), false);
});

test("tree preflight detects a different Genome in the target branch", () => {
  const first = { genome_id: "harness:first", version: 1 };
  const second = { genome_id: "harness:second", version: 1 };
  const entries = [
    { type: "custom", id: "root", parentId: null, customType: "rsih.genome",
      data: { genome: first, reference: "first" } },
    { type: "message", id: "a1", parentId: "root" },
    { type: "custom", id: "b1", parentId: "root", customType: "rsih.genome",
      data: { genome: second, reference: "second" } },
    { type: "message", id: "b2", parentId: "b1" },
    { type: "message", id: "a2", parentId: "a1" },
  ];
  const current = { genome: first, reference: "first" };
  assert.equal(sessionGenomeChanged(
    current, latestSessionGenome(sessionBranchEntries(entries, "b2")),
  ), true, "navigating to another Genome must be blocked");
  assert.equal(sessionGenomeChanged(
    current, latestSessionGenome(sessionBranchEntries(entries, "a2")),
  ), false, "a branch of the active Genome remains navigable");
});

test("fork and clone preflight use the retained ancestry, including boundary entries", () => {
  const original = { genome_id: "harness:first", version: 1 };
  const switched = { genome_id: "harness:second", version: 1 };
  const entries = [
    { type: "custom", id: "a", parentId: null, customType: "rsih.genome",
      data: { reference: "first", genome: original } },
    { type: "message", id: "a-user", parentId: "a" },
    { type: "custom", id: "b", parentId: "a-user", customType: "rsih.genome",
      data: { reference: "second", genome: switched } },
    { type: "message", id: "b-user", parentId: "b" },
  ];
  const activeFirst = { reference: "first", genome: original };
  const activeSecond = { reference: "second", genome: switched };
  const beforeSwitch = latestSessionGenome(sessionForkBranchEntries(entries, "b", "before"));
  const atSwitch = latestSessionGenome(sessionForkBranchEntries(entries, "b", "at"));

  assert.equal(beforeSwitch.reference, "first", "/fork excludes the chosen entry");
  assert.equal(atSwitch.reference, "second", "/clone retains the chosen entry");
  assert.equal(sessionGenomeChanged(activeFirst, beforeSwitch), false);
  assert.equal(sessionGenomeChanged(activeFirst, atSwitch), true);
  assert.equal(sessionGenomeChanged(
    activeSecond, latestSessionGenome(sessionForkBranchEntries(entries, "a-user", "before")),
  ), true, "forking from the older Genome must be rejected");
  assert.equal(sessionGenomeChanged(
    activeSecond, latestSessionGenome(sessionForkBranchEntries(entries, "b-user", "before")),
  ), false, "forking within the active Genome remains allowed");
  assert.deepEqual(sessionForkBranchEntries(entries, "missing", "before"), []);
});

test("default Genome /tree keeps matching configuration without reopening the session", async t => {
  const root = mkdtempSync(join(tmpdir(), "rsih-default-tree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });

  const manager = SessionManager.create(cwd, join(agent, "sessions"));
  const genome = createDefaultHarnessGenome();
  manager.appendCustomEntry("rsih.genome", { reference: "default", baseDirectory: cwd, genome });
  manager.appendCustomEntry("rsih.configuration", createConfigurationSnapshot({}, {}, {
    genome: "default", genomeId: genome.genome_id, rsih: "0.1.0",
  }));
  const selectedId = manager.appendMessage({
    role: "user", content: [{ type: "text", text: "Edit this question." }], timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Original answer." }], timestamp: Date.now(),
  });

  const configuration = createRuntimeSettings(agent);
  configuration.apply({ settings: {}, snapshotSettings: {}, keybindings: {} });
  const session = createGenomeSession(
    genomeActivation({ genome, reference: "default", baseDirectory: cwd }),
    startupPromptRecord({}),
  );
  const handlers = new Map();
  let appended = 0;
  const pi = {
    registerFlag() {}, registerCommand() {},
    on(name, handler) { handlers.set(name, handler); },
    appendEntry() { appended++; },
    sendUserMessage() { assert.fail("unchanged /tree must not request a session restore"); },
  };
  const factory = await createGenomeExtension({ session, configuration, profiles: {}, cwd });
  await factory(pi);
  const ctx = { mode: "rpc", sessionManager: manager, ui: { getEditorText: () => "", notify() {} } };

  const before = await handlers.get("session_before_tree")({ preparation: { targetId: selectedId } }, ctx);
  assert.notEqual(before?.cancel, true);
  const targetLeaf = manager.getEntry(selectedId).parentId;
  manager.branch(targetLeaf);
  await handlers.get("session_tree")({}, ctx);
  assert.equal(appended, 0, "an unchanged branch must not add an rsih.branch marker");
  assert.equal(manager.getLeafId(), targetLeaf, "ordinary tree navigation still changes the active leaf");
});

async function frozenTreeFixture(t, restoreSessionOnStartup = false) {
  const root = mkdtempSync(join(tmpdir(), "rsih-frozen-tree-"));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const savedEnvironment = new Map(["PI_CODING_AGENT_DIR", "RSIH_CODING_AGENT_DIR", SUPERVISED_ENV]
    .map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.RSIH_CODING_AGENT_DIR = agent;
  process.env[SUPERVISED_ENV] = "1";
  t.after(() => {
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const manager = SessionManager.create(cwd, join(agent, "sessions"));
  const oldGenome = { genome_schema_version: "2", genome_id: "harness:demo", version: 1,
    extensions: ["./old-extension.ts"], settings: { steeringMode: "one-at-a-time" } };
  const newGenome = { ...oldGenome, extensions: ["./new-extension.ts"], settings: { steeringMode: "all" } };
  const record = genome => ({ reference: "demo", baseDirectory: root, genome });
  manager.appendCustomEntry("rsih.genome", record(oldGenome));
  manager.appendCustomEntry("rsih.configuration", snapshot(oldGenome.settings));
  const selectedId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "First question." }], timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "First answer." }], timestamp: Date.now() });
  manager.appendCustomEntry("rsih.genome", record(newGenome));
  manager.appendCustomEntry("rsih.configuration", snapshot(newGenome.settings));
  const configuration = createRuntimeSettings(agent);
  configuration.apply({ settings: newGenome.settings });
  const session = createGenomeSession(genomeActivation(record(newGenome)), startupPromptRecord({}));
  const handlers = new Map();
  const pi = {
    registerFlag() {}, registerCommand() {},
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(name, data) { manager.appendCustomEntry(name, data); },
  };
  const factory = await createGenomeExtension({ session, configuration, restoreSessionOnStartup, profiles: {}, cwd });
  await factory(pi);
  let shutdown = false;
  const ctx = { mode: "tui", sessionManager: manager,
    ui: { getEditorText: () => "", notify() {} }, shutdown() { shutdown = true; } };
  return { agent, manager, handlers, ctx, selectedId, oldGenome, shutdown: () => shutdown };
}

test("supervised tree restores a frozen branch and its editor text without duplicate snapshots", async t => {
  const { agent, manager, handlers, ctx, selectedId, oldGenome, shutdown } = await frozenTreeFixture(t);
  const before = await handlers.get("session_before_tree")({ preparation: { targetId: selectedId } }, ctx);
  assert.notEqual(before?.cancel, true);
  manager.branch(manager.getEntry(selectedId).parentId); // Pi re-edits a user entry from its parent.
  await handlers.get("session_tree")({}, ctx);
  assert.equal(shutdown(), true);
  const request = takeSwitchRequest(agent);
  assert.equal(request.kind, "resume");
  assert.equal(request.sessionFile, manager.getSessionFile());
  assert.equal(request.editorText, "First question.");
  const entries = readFileSync(manager.getSessionFile(), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  const branch = sessionBranchEntries(entries);
  assert.deepEqual(latestSessionGenome(branch).genome, oldGenome);
  assert.equal(findLatestSnapshot(branch).settings.steeringMode, "one-at-a-time");
  assert.equal(entries.filter(entry => entry.customType === "rsih.configuration").length, 2);
  assert.equal(entries.at(-1).customType, "rsih.branch");
});

test("RPC still refuses a branch requiring different startup extensions", async t => {
  const { manager, handlers, ctx, selectedId } = await frozenTreeFixture(t);
  ctx.mode = "rpc";
  const leaf = manager.getLeafId();
  const result = await handlers.get("session_before_tree")({ preparation: { targetId: selectedId } }, ctx);
  assert.equal(result.cancel, true);
  assert.equal(manager.getLeafId(), leaf);
});

test("startup picker restoration marks initial messages as not yet consumed", async t => {
  const { agent, manager, handlers, ctx, selectedId, shutdown } = await frozenTreeFixture(t, true);
  manager.branch(manager.getEntry(selectedId).parentId);
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.equal(shutdown(), true);
  assert.equal(takeSwitchRequest(agent).preserveInitialMessages, true);
});
