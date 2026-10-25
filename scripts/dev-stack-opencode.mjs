#!/usr/bin/env node
// Host-only OpenCode wrapper. Opening a terminal never probes a paid model or reads installed provider homes.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory, privateFileStat } from "./dev-stack-state.mjs";

/** Build the same private provider environment for the supervised server and its terminal clients. */
export function openCodeEnvironment(state, base = process.env) {
  const home = privateDirectory(state, "data/providers/opencode");
  const env = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TERM", "COLORTERM", "USER", "LOGNAME", "SPACE_CLI_WORKSPACE", "SPACE_ROOM_ID", "SPACE_PANE_ID", "SPACE_CLI_SESSION_ID", "OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD"]) if (base[key]) env[key] = base[key];
  Object.assign(env, {
    HOME: home, TMPDIR: join(home, "tmp"), XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "true"
  });
  for (const name of ["tmp", "config", "data", "cache", "state"]) privateDirectory(home, name);
  return env;
}

/** Select the legacy CLI or attach OpenCode 2 panes to the one supervised loopback server. */
export function openCodeArguments(packageName, args, port, cwd = process.cwd()) {
  if (packageName === "opencode-ai") return args;
  if (packageName !== "@opencode/cli") throw new Error("Unsupported OpenCode package.");
  if (args[0] === "serve" || args.some((arg) => arg === "--server" || arg.startsWith("--server="))) throw new Error("Use the dev-stack supervised OpenCode server.");
  if (["--help", "-h", "--version", "-v", "version"].includes(args[0])) return args;
  if (!args.length || ["--continue", "-c"].includes(args[0])) {
    if (!/^\d+$/.test(String(port)) || Number(port) < 1024 || Number(port) > 65535) throw new Error("OpenCode pane requires the supervised loopback port.");
    return ["--server", `http://127.0.0.1:${Number(port)}`, ...args, cwd];
  }
  // Non-pane commands must not launch OpenCode's per-user background service.
  return args.includes("--standalone") ? args : [...args, "--standalone"];
}

/** Handle fixed credential diagnostics or launch a terminal without forwarding inherited provider secrets. */
export function main(input = process.argv.slice(2)) {
  const [state, packageName, port, ...provided] = input;
  if (!state || !["opencode-ai", "@opencode/cli"].includes(packageName)) throw new Error("Usage: dev-stack-opencode.mjs <state> <pinned-package> <server-port> [arguments]");
  const args = provided[0] === "--run-inner" ? provided.slice(1) : provided;
  const tool = join(state, "tools/node_modules/.bin/opencode");
  const env = openCodeEnvironment(state);
  switch (args[0]) {
    case "credential-status":
      console.log(existsSync(tool) ? "READY" : "NOT_READY");
      process.exitCode = existsSync(tool) ? 0 : 1;
      return;
    case "credential-observation":
      process.exitCode = 1;
      return;
    case "credential-smoke":
      console.error("The source stack does not probe external AI models. Open the OpenCode UI to configure a provider.");
      process.exitCode = 1;
      return;
    case "inspect-env":
      console.log("runtime=opencode\nhome=isolated\ncredential=not-probed");
      return;
    default: {
      const argv = openCodeArguments(packageName, args, port);
      if (argv[0] === "--server") {
        const path = join(privateDirectory(state, "secrets"), "opencode-password");
        if (!privateFileStat(path, "secret file")) throw new Error("OpenCode pane requires the private server credential.");
        const password = readFileSync(path, "utf8").trim();
        if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("Invalid OpenCode server credential.");
        // The CLI host intentionally does not forward the supervisor's environment.
        // Read the generated credential directly, never put it in wrapper arguments or terminal output.
        env.OPENCODE_SERVER_USERNAME = "opencode";
        env.OPENCODE_SERVER_PASSWORD = password;
      }
      const child = spawn(tool, argv, { env, stdio: "inherit" });
      const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, () => child.kill(signal)]));
      for (const [signal, handler] of handlers) process.once(signal, handler);
      child.once("error", (error) => { console.error(`OpenCode could not start: ${error.message}`); process.exitCode = 1; });
      child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
      child.once("close", () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
