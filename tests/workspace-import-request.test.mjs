import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRequest,
  runRequest,
} from "../scripts/run-workspace-import-request.mjs";

const envelope = "Encrypted_fixture-123";
const request = (mode, value = envelope) =>
  JSON.stringify({
    version: 1,
    mode,
    ...(mode === "prepare" ? {} : { envelope: value }),
  });

test("Protected requests accept only supported modes and bounded base64url envelopes", () => {
  assert.deepEqual(parseRequest(request("prepare")), {
    version: 1,
    mode: "prepare",
  });
  for (const mode of ["dry-run", "apply"])
    assert.deepEqual(parseRequest(request(mode)), {
      version: 1,
      mode,
      envelope,
    });
  assert.equal(
    parseRequest(request("apply", "a".repeat(60000))).envelope.length,
    60000,
  );
  const minimal = request("prepare");
  assert.deepEqual(
    parseRequest(minimal + " ".repeat(65000 - Buffer.byteLength(minimal))),
    {
      version: 1,
      mode: "prepare",
    },
  );
});

test("Malformed, extra, plaintext and oversized request fields fail without echoing their values", () => {
  const privateFixture = "PRIVATE_FIXTURE_VALUE_DO_NOT_LOG";
  for (const input of [
    "not-json-" + privateFixture,
    "null",
    "[]",
    "true",
    JSON.stringify({ version: 2, mode: "prepare" }),
    JSON.stringify({ mode: "prepare" }),
    JSON.stringify({ version: 1, mode: "stage", envelope }),
    JSON.stringify({ version: 1, mode: "prepare", envelope }),
    JSON.stringify({ version: 1, mode: "prepare", envelope: null }),
    JSON.stringify({ version: 1, mode: "apply" }),
    JSON.stringify({
      version: 1,
      mode: "apply",
      envelope,
      token: privateFixture,
    }),
    JSON.stringify({
      version: 1,
      mode: "apply",
      envelope,
      sponsors: [privateFixture],
    }),
    request("apply", privateFixture + " /+="),
    request("apply", ""),
    request("apply", "a".repeat(60001)),
    request("prepare") + " ".repeat(65000),
  ])
    assert.throws(
      () => parseRequest(input),
      (error) => {
        assert.equal(
          error.message,
          "The protected workspace import request is invalid.",
        );
        assert.equal(error.message.includes(privateFixture), false);
        return true;
      },
    );
});

test("Apply checks the same envelope first and stops immediately on any failed mode", () => {
  const calls = [];
  runRequest(request("apply"), (mode, value) => calls.push([mode, value]));
  assert.deepEqual(calls, [
    ["dry-run", envelope],
    ["apply", envelope],
  ]);
  for (const mode of ["prepare", "dry-run"]) {
    calls.length = 0;
    runRequest(request(mode), (step, value) => calls.push([step, value]));
    assert.deepEqual(calls, [
      [mode, mode === "prepare" ? undefined : envelope],
    ]);
  }
  for (const failOn of ["dry-run", "apply"]) {
    calls.length = 0;
    assert.throws(
      () =>
        runRequest(request("apply"), (mode) => {
          calls.push(mode);
          if (mode === failOn) throw new Error("Fixture execution failed.");
        }),
      /Fixture execution failed/,
    );
    assert.deepEqual(
      calls,
      failOn === "dry-run" ? ["dry-run"] : ["dry-run", "apply"],
    );
  }
  calls.length = 0;
  assert.throws(() => runRequest("{}", (mode) => calls.push(mode)), /invalid/);
  assert.deepEqual(calls, []);
});

test("CLI handles deletion safely, forwards only validated mode inputs and fails before apply", () => {
  const dir = mkdtempSync(join(tmpdir(), "maestro-import-request-test-"));
  const script = join(dir, "scripts", "run-workspace-import-request.mjs");
  const path = join(dir, ".github", "workspace-import-request.json");
  const trace = join(dir, "trace.jsonl");
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, ".github"));
  copyFileSync(
    new URL("../scripts/run-workspace-import-request.mjs", import.meta.url),
    script,
  );
  writeFileSync(
    join(dir, "scripts", "workspace-import.mjs"),
    `
    import { appendFileSync } from "node:fs";
    appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({
      mode: process.env.IMPORT_MODE,
      envelope: process.env.IMPORT_ENVELOPE,
      credentialBound: Boolean(process.env.SUPABASE_ACCESS_TOKEN)
    }) + "\\n");
    if (process.env.IMPORT_MODE === process.env.FIXTURE_FAIL_ON) process.exit(3);
    console.log("Fixture mode completed.");
  `,
  );
  const run = (extra = {}) =>
    spawnSync(process.execPath, [script], {
      cwd: tmpdir(),
      encoding: "utf8",
      env: {
        ...process.env,
        IMPORT_MODE: "stage",
        IMPORT_ENVELOPE: "UnrelatedFixture",
        SUPABASE_ACCESS_TOKEN: "ProtectedFixtureCredential",
        FIXTURE_TRACE: trace,
        ...extra,
      },
    });
  const records = () =>
    readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
  try {
    let result = run();
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /No protected workspace import request is present/,
    );
    writeFileSync(path, request("apply"));
    result = run();
    assert.equal(result.status, 0);
    assert.deepEqual(records(), [
      { mode: "dry-run", envelope, credentialBound: true },
      { mode: "apply", envelope, credentialBound: true },
    ]);
    assert.equal((result.stdout + result.stderr).includes(envelope), false);
    assert.equal(
      (result.stdout + result.stderr).includes("ProtectedFixtureCredential"),
      false,
    );
    rmSync(trace);
    result = run({ FIXTURE_FAIL_ON: "dry-run" });
    assert.equal(result.status, 1);
    assert.deepEqual(
      records().map((entry) => entry.mode),
      ["dry-run"],
    );
    assert.match(result.stderr, /Protected workspace import request failed/);
    rmSync(trace);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        mode: "apply",
        envelope,
        secret: "PrivateFixture",
      }),
    );
    result = run();
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes("PrivateFixture"), false);
    assert.throws(() => readFileSync(trace), { code: "ENOENT" });
    rmSync(path);
    symlinkSync(join(dir, "scripts", "workspace-import.mjs"), path);
    result = run();
    assert.equal(result.status, 1);
    assert.throws(() => readFileSync(trace), { code: "ENOENT" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
