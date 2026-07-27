import { spawn } from "node:child_process";

function spawnNpm(script) {
  if (process.env.npm_execpath) {
    return spawn(process.execPath, [process.env.npm_execpath, "run", script], { stdio: "inherit" });
  }
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawn(command, ["run", script], { stdio: "inherit", shell: process.platform === "win32" });
}

const children = [
  spawnNpm("dev:web"),
  spawnNpm("dev:server"),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}

for (const child of children) {
  child.on("exit", (code) => stop(code ?? 1));
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
