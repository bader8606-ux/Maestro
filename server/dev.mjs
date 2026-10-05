import { spawn } from "node:child_process";
const processes = [
  spawn(process.execPath, ["--watch", "server/index.mjs"], {
    stdio: "inherit",
  }),
  spawn("node_modules/.bin/vite", [], { stdio: "inherit" }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of processes) p.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300).unref();
}
for (const p of processes) {
  p.on("error", () => stop(1));
  p.on("exit", (code) => stop(code ?? 1));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
