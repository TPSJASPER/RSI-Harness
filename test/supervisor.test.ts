import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SUPERVISED_ENV,
  SWITCHED_FROM_ENV,
  SWITCH_REQUEST_ID_ENV,
  RESTORED_EDITOR_ENV,
  restartArgv,
  supervise,
  takeSwitchRequest,
  wantsInteractive,
  writeSwitchRequest,
} from "../src/cli/supervisor.ts";

const tty = { isTTY: true };
const pipe = { isTTY: false };

test("only a terminal on both ends with no one-shot flag is interactive", () => {
  const io = { stdin: tty, stdout: tty };
  assert.equal(wantsInteractive([], io), true);
  assert.equal(wantsInteractive(["--genome", "dev", "--cwd", "."], io), true);
  assert.equal(wantsInteractive([":paperlab"], io), true);

  assert.equal(wantsInteractive([], { stdin: pipe, stdout: tty }), false);
  assert.equal(wantsInteractive([], { stdin: tty, stdout: pipe }), false);
  assert.equal(wantsInteractive(["-p", "hi"], io), false);
  assert.equal(wantsInteractive(["--json"], io), false);
  assert.equal(wantsInteractive(["--mode", "rpc"], io), false);
  assert.equal(wantsInteractive(["--mode=rpc"], io), false);
  assert.equal(wantsInteractive(["genome", "list"], io), false);
  assert.equal(wantsInteractive(["--help"], io), false);
  assert.equal(wantsInteractive(["--list-models"], io), false);
});

test("a restart keeps the user's flags and replaces only Genome and session", () => {
  const request = { reference: "debate", sessionFile: "/s/a.jsonl" };
  assert.deepEqual(
    restartArgv(
      ["--genome", "dev", "--cwd", "/repo", "--run-id", "x", "--thinking", "high", "-c"],
      request,
    ),
    ["--genome", "debate", "--session", "/s/a.jsonl", "--cwd", "/repo", "--thinking", "high"],
  );
  // `--genome=dev` and a shorthand-expanded argv both collapse the same way.
  assert.deepEqual(restartArgv(["--genome=dev", "--new"], request), [
    "--genome",
    "debate",
    "--session",
    "/s/a.jsonl",
  ]);
  // Nothing to resume from: the restart still carries the new Genome.
  assert.deepEqual(restartArgv(["--genome", "dev"], { reference: "debate" }), [
    "--genome",
    "debate",
  ]);
});

test("a switch request is read exactly once and never survives a bad body", () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-sup-"));
  try {
    assert.equal(takeSwitchRequest(directory), undefined);

    writeSwitchRequest(directory, { reference: "debate", sessionFile: "/s.jsonl", from: "dev" });
    assert.deepEqual(takeSwitchRequest(directory), {
      reference: "debate",
      sessionFile: "/s.jsonl",
      from: "dev",
    });
    assert.equal(takeSwitchRequest(directory), undefined);

    // A crash mid-write must not become a restart loop on the next launch.
    writeFileSync(join(directory, ".switch-genome.json"), "{not json", "utf8");
    assert.equal(takeSwitchRequest(directory), undefined);
    assert.equal(existsSync(join(directory, ".switch-genome.json")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A child that runs a script instead of a process: each entry is what one
 * spawn does before exiting. Lets the loop be tested without a terminal.
 */
function scriptedSpawn(script, calls) {
  return (command, args, options) => {
    const step = script[calls.length];
    calls.push({ command, args, env: options.env });
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {};
    setImmediate(() => {
      step?.before?.(options);
      child.exitCode = step?.code ?? 0;
      child.emit("exit", step?.code ?? 0, step?.signal ?? null);
    });
    return child;
  };
}

test("the supervisor restarts on a request and stops when there is none", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-sup-"));
  try {
    const calls = [];
    const code = await supervise({
      command: "rsih",
      baseArgs: ["cli.ts"],
      argv: ["--genome", "dev", "--cwd", "/repo"],
      agentDirectory: directory,
      env: { HOME: "/home/u" },
      spawnChild: scriptedSpawn(
        [
          {
            before: ({ env }) =>
              writeSwitchRequest(directory, {
                reference: "debate",
                sessionFile: "/s/a.jsonl",
                from: "dev",
              }, env[SWITCH_REQUEST_ID_ENV]),
          },
          { code: 0 },
        ],
        calls,
      ),
    });

    assert.equal(code, 0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ["cli.ts", "--genome", "dev", "--cwd", "/repo"]);
    assert.equal(calls[0].env[SUPERVISED_ENV], "1");
    assert.equal(SWITCHED_FROM_ENV in calls[0].env, false);

    assert.deepEqual(calls[1].args, [
      "cli.ts",
      "--genome",
      "debate",
      "--session",
      "/s/a.jsonl",
      "--cwd",
      "/repo",
    ]);
    assert.equal(calls[1].env[SWITCHED_FROM_ENV], "dev");
    // The user's environment reaches the child untouched.
    assert.equal(calls[1].env.HOME, "/home/u");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("supervisors sharing an agent directory consume only their own switch requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-sup-parallel-"));
  try {
    const a = [];
    const b = [];
    const launch = (name, calls) => supervise({
      command: "rsih", baseArgs: [], argv: ["--genome", name], agentDirectory: directory, env: {},
      spawnChild: scriptedSpawn([
        { before: ({ env }) => writeSwitchRequest(directory,
          { reference: `${name}-next`, sessionFile: `/sessions/${name}.jsonl` }, env[SWITCH_REQUEST_ID_ENV]) },
        { code: 0 },
      ], calls),
    });
    assert.deepEqual(await Promise.all([launch("a", a), launch("b", b)]), [0, 0]);
    assert.notEqual(a[0].env[SWITCH_REQUEST_ID_ENV], b[0].env[SWITCH_REQUEST_ID_ENV]);
    assert.equal(a[1].args[1], "a-next");
    assert.equal(b[1].args[1], "b-next");
    assert.ok(a[1].args.includes("/sessions/a.jsonl"));
    assert.ok(b[1].args.includes("/sessions/b.jsonl"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a child's exit code passes through when it did not ask to restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-sup-"));
  try {
    const calls = [];
    const code = await supervise({
      command: "rsih",
      baseArgs: [],
      argv: [],
      agentDirectory: directory,
      env: {},
      spawnChild: scriptedSpawn([{ code: 3 }], calls),
    });
    assert.equal(code, 3);
    assert.equal(calls.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a request left by a crash is honoured, but a restart storm is not", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-sup-"));
  try {
    const written = [];
    const stderr = { write: (text) => written.push(text) };
    let clock = 0;
    const calls = [];
    const file = ({ env }) =>
      writeSwitchRequest(directory, { reference: "loop", sessionFile: "/s.jsonl" }, env[SWITCH_REQUEST_ID_ENV]);
    const code = await supervise({
      command: "rsih",
      baseArgs: [],
      argv: [],
      agentDirectory: directory,
      env: {},
      now: () => (clock += 100),
      stderr,
      // Every run immediately asks to be restarted.
      spawnChild: scriptedSpawn(Array.from({ length: 20 }, () => ({ before: file })), calls),
    });
    assert.equal(code, 1);
    // Five restarts are allowed inside the window; the sixth is refused.
    assert.equal(calls.length, 6);
    assert.match(written.join(""), /refusing to restart/);
    assert.equal(existsSync(join(directory, ".switch-genome.json")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("resume restart loads the target session's frozen Genome instead of passing --genome", () => {
  const argv = ["--genome", "old", "--resume", "--cwd", "/work"];
  const restarted = restartArgv(argv, {
    kind: "resume",
    reference: "different",
    sessionFile: "/sessions/selected.jsonl",
  });
  assert.deepEqual(restarted, ["--session", "/sessions/selected.jsonl", "--cwd", "/work"]);
});

test("in-app restarts discard consumed input and names while retaining option values", () => {
  const argv = ["--genome", "old", "--name", "Initial A", "--cwd", "/work",
    "--model", "initial prompt", "--extension", "@extension.ts", "--custom", "custom value",
    "--verbose", "initial prompt", "@notes.md", "--", "--literal-message"];
  assert.deepEqual(restartArgv(argv, { kind: "resume", reference: "target", sessionFile: "/b.jsonl" }),
    ["--session", "/b.jsonl", "--cwd", "/work", "--model", "initial prompt",
      "--extension", "@extension.ts", "--custom", "custom value", "--verbose"]);
  assert.deepEqual(restartArgv(["-n", "Old name", "hello", "@notes.md"], { reference: "new" }),
    ["--genome", "new"]);
});

test("startup restoration retains pending input once, without renaming the session again", () => {
  const argv = ["--resume", "--name", "Target", "--cwd", "/work", "hello", "@notes.md", "--", "--literal"];
  const startup = restartArgv(argv, { kind: "resume", reference: "target", sessionFile: "/b.jsonl",
    preserveInitialMessages: true });
  assert.deepEqual(startup, ["--session", "/b.jsonl", "--cwd", "/work", "hello", "@notes.md", "--", "--literal"]);
  assert.deepEqual(restartArgv(startup, { kind: "resume", reference: "other", sessionFile: "/c.jsonl" }),
    ["--session", "/c.jsonl", "--cwd", "/work"]);
});

test("restart input filtering follows Pi's extension-flag parsing and preserves RSIH paths", () => {
  assert.deepEqual(restartArgv(["--custom", "@input.md", "--cwd", "@project", "--append-system-prompt", "--name"],
    { kind: "resume", reference: "target", sessionFile: "/b.jsonl" }),
    ["--session", "/b.jsonl", "--custom", "--cwd", "@project", "--append-system-prompt", "--name"]);
});

test("the supervisor carries a branch draft only to the requested restart", async t => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-editor-restore-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  await supervise({
    command: "rsih", baseArgs: [], argv: [], agentDirectory: directory, env: {},
    spawnChild: scriptedSpawn([
      { before: ({ env }) => writeSwitchRequest(directory,
        { kind: "resume", reference: "demo", sessionFile: "/a.jsonl", editorText: "Re-edit this question." }, env[SWITCH_REQUEST_ID_ENV]) },
      { before: ({ env }) => writeSwitchRequest(directory,
        { kind: "resume", reference: "demo", sessionFile: "/b.jsonl" }, env[SWITCH_REQUEST_ID_ENV]) },
      {},
    ], calls),
  });
  assert.equal(calls[1].env[RESTORED_EDITOR_ENV], "Re-edit this question.");
  assert.equal(calls[2].env[RESTORED_EDITOR_ENV], undefined);
});
