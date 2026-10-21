// Push-triggered requests contain only a mode and an encrypted envelope.
import { lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const maxRequestBytes = 65000;
const invalidRequest = () =>
  new Error("The protected workspace import request is invalid.");

export function parseRequest(text) {
  try {
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text, "utf8") > maxRequestBytes
    )
      throw invalidRequest();
    const request = JSON.parse(text);
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      Object.keys(request).some(
        (key) => !["version", "mode", "envelope"].includes(key),
      ) ||
      request.version !== 1 ||
      !["prepare", "dry-run", "apply"].includes(request.mode)
    )
      throw invalidRequest();
    if (request.mode === "prepare") {
      if (Object.hasOwn(request, "envelope")) throw invalidRequest();
      return { version: 1, mode: "prepare" };
    }
    if (
      typeof request.envelope !== "string" ||
      request.envelope.length > 60000 ||
      !/^[A-Za-z0-9_-]+$/.test(request.envelope)
    )
      throw invalidRequest();
    return { version: 1, mode: request.mode, envelope: request.envelope };
  } catch {
    // JSON/parser diagnostics may contain parts of a rejected input.
    throw invalidRequest();
  }
}

export function runRequest(text, executeMode) {
  const request = parseRequest(text);
  const modes =
    request.mode === "apply" ? ["dry-run", "apply"] : [request.mode];
  for (const mode of modes) executeMode(mode, request.envelope);
}

function main() {
  const path = new URL(
    "../.github/workspace-import-request.json",
    import.meta.url,
  );
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw invalidRequest();
    console.log("No protected workspace import request is present.");
    return;
  }
  if (!info.isFile() || info.size > maxRequestBytes) throw invalidRequest();
  runRequest(readFileSync(path, "utf8"), (mode, envelope) => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./workspace-import.mjs", import.meta.url))],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: {
          ...process.env,
          IMPORT_MODE: mode,
          IMPORT_ENVELOPE: envelope || "",
        },
        stdio: "inherit",
      },
    );
    if (result.error || result.status !== 0)
      throw new Error("The protected workspace import step failed.");
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch {
    console.error(
      "Protected workspace import request failed; no request details were logged.",
    );
    process.exitCode = 1;
  }
}
