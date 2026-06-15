import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.distrai.gateway";

/** Repo root — this file lives at <repo>/apps/cli/src/service.ts. */
function repoRoot(): string {
  return resolve(fileURLToPath(import.meta.url), "../../../..");
}
function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}
function logDir(): string {
  return join(homedir(), ".distrai");
}
function tsxEntry(repo: string): string {
  const candidates = [
    join(repo, "node_modules", "tsx", "dist", "cli.mjs"),
    join(repo, "node_modules", ".bin", "tsx"),
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildPlist(port: number): string {
  const repo = repoRoot();
  const gateway = join(repo, "apps", "gateway", "src", "index.ts");
  const env: Array<[string, string]> = [
    ["PATH", process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin"],
    ["HOME", homedir()],
    ["DISTRAI_GATEWAY_PORT", String(port)],
  ];
  // Carry over any auth/overflow env present at install time so the daemon has it too.
  for (const k of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "DISTRAI_PASS_API_KEYS",
  ]) {
    if (process.env[k]) env.push([k, process.env[k]!]);
  }
  const envXml = env
    .map(([k, v]) => `      <key>${k}</key><string>${escapeXml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(tsxEntry(repo))}</string>
    <string>${escapeXml(gateway)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(join(logDir(), "gateway.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(logDir(), "gateway.err"))}</string>
</dict>
</plist>
`;
}

function uid(): number {
  return process.getuid?.() ?? 0;
}
function loadAgent(plist: string): void {
  try {
    execFileSync("launchctl", ["bootstrap", `gui/${uid()}`, plist], { stdio: "ignore" });
  } catch {
    execFileSync("launchctl", ["load", "-w", plist], { stdio: "ignore" });
  }
}
function unloadAgent(plist: string): void {
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], { stdio: "ignore" });
  } catch {
    try {
      execFileSync("launchctl", ["unload", plist], { stdio: "ignore" });
    } catch {
      /* not loaded */
    }
  }
}

export async function runService(argv: string[]): Promise<void> {
  if (platform() !== "darwin") {
    console.error(
      "`distrai service` manages a macOS launchd background service. On Linux, use a " +
        "systemd --user unit; on any OS you can just run `pnpm gateway`.",
    );
    process.exit(1);
  }
  const sub = argv[0] ?? "";
  let port = 6767;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--port") port = Number(argv[++i]);
  }
  const plist = plistPath();

  switch (sub) {
    case "install": {
      mkdirSync(logDir(), { recursive: true });
      mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(plist, buildPlist(port));
      unloadAgent(plist); // replace any existing instance
      loadAgent(plist);
      console.log(`✓ distrai gateway installed as a background service (${LABEL}).`);
      console.log(
        `  Running on http://127.0.0.1:${port} — auto-starts on login, restarts on crash, idle = $0.`,
      );
      console.log("\nPoint Claude Code at it — add to ~/.claude/settings.json:");
      console.log(
        `  { "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:${port}", "ANTHROPIC_AUTH_TOKEN": "distrai" } }`,
      );
      console.log(
        `\nManage: distrai service status | restart | logs | uninstall   ·   logs: ${join(logDir(), "gateway.log")}`,
      );
      return;
    }
    case "uninstall": {
      unloadAgent(plist);
      if (existsSync(plist)) rmSync(plist);
      console.log("✓ distrai gateway service removed.");
      return;
    }
    case "restart": {
      if (!existsSync(plist)) {
        console.error("Not installed. Run: distrai service install");
        process.exit(1);
      }
      unloadAgent(plist);
      loadAgent(plist);
      console.log("✓ distrai gateway restarted.");
      return;
    }
    case "status": {
      console.log(`plist:   ${existsSync(plist) ? plist : "(not installed)"}`);
      try {
        const list = execFileSync("launchctl", ["list"], { encoding: "utf8" });
        const line = list.split("\n").find((l) => l.includes(LABEL));
        console.log(`launchd: ${line ? line.trim() : "not loaded"}`);
      } catch {
        /* ignore */
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
          signal: AbortSignal.timeout(2000),
        });
        console.log(`health:  ${res.ok ? "reachable ✓" : `HTTP ${res.status}`} (http://127.0.0.1:${port})`);
      } catch {
        console.log(`health:  not reachable on http://127.0.0.1:${port}`);
      }
      return;
    }
    case "logs":
      return runLogs(argv.slice(1));
    default:
      console.error("usage: distrai service <install|uninstall|restart|status|logs> [--port N]");
      process.exit(1);
  }
}

// ── `distrai logs` — tail the gateway's detailed debug log ──

const LEVEL_ORDER: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface LogsArgs {
  follow: boolean;
  lines: number;
  level?: string;
}

function parseLogsArgs(argv: string[]): LogsArgs {
  const out: LogsArgs = { follow: false, lines: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-f" || a === "--follow") out.follow = true;
    else if (a === "-n" || a === "--lines") out.lines = Number(argv[++i]);
    else if (a === "--level") out.level = String(argv[++i] ?? "").toLowerCase();
  }
  return out;
}

/** Parse the level token out of a human log line ("<ts> INFO  [turn] msg"). */
function lineLevel(line: string): string | undefined {
  const m = line.match(/^\S+\s+(DEBUG|INFO|WARN|ERROR)\b/);
  return m ? m[1].toLowerCase() : undefined;
}

/** Keep crash/non-structured lines always; otherwise gate on the requested minimum level. */
function passesLevel(line: string, min?: number): boolean {
  if (min === undefined) return true;
  const lvl = lineLevel(line);
  if (!lvl) return true; // never hide stderr/crash output the gateway didn't format
  return LEVEL_ORDER[lvl] >= min;
}

export async function runLogs(argv: string[]): Promise<void> {
  const args = parseLogsArgs(argv);
  const min = args.level ? LEVEL_ORDER[args.level] : undefined;
  if (args.level && min === undefined) {
    console.error(`unknown --level '${args.level}' (use: debug | info | warn | error)`);
    process.exit(1);
  }
  // The gateway logs to stdout (gateway.log under the service); crashes land on stderr (gateway.err).
  const out = join(logDir(), "gateway.log");
  const err = join(logDir(), "gateway.err");

  if (!existsSync(out) && !existsSync(err)) {
    console.log(
      `(no logs yet in ${logDir()}). Start the gateway with 'pnpm gateway' or install the ` +
        `service with 'distrai service install', then check 'distrai service status'.`,
    );
    return;
  }

  // Snapshot: last N lines of the main log, plus any crash output from stderr.
  const tailLines = (file: string, n: number): string[] =>
    existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-n) : [];
  for (const line of tailLines(out, args.lines)) {
    if (passesLevel(line, min)) console.log(line);
  }
  const crashes = tailLines(err, 20);
  if (crashes.length) {
    console.log("\n── gateway stderr (crashes) ──");
    for (const line of crashes) console.log(line);
  }

  if (!args.follow) return;

  // Follow mode: stream new lines from the main log (and stderr) as they arrive.
  console.log(`\n── following ${out} (Ctrl-C to stop) ──`);
  const tails = [out, err]
    .filter(existsSync)
    .map((file) => spawn("tail", ["-n", "0", "-F", file], { stdio: ["ignore", "pipe", "ignore"] }));
  await new Promise<void>((resolveFollow) => {
    for (const t of tails) {
      let buf = "";
      t.stdout?.on("data", (b: Buffer) => {
        buf += b.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line && passesLevel(line, min)) console.log(line);
        }
      });
    }
    const stop = () => {
      for (const t of tails) t.kill();
      resolveFollow();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
