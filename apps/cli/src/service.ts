import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";

const LABEL = "com.frites.gateway";
const SYSTEMD_UNIT = "frites-gateway.service";

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}
function systemdUserDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}
function systemdUnitPath(): string {
  return join(systemdUserDir(), SYSTEMD_UNIT);
}
function logDir(): string {
  return join(homedir(), ".frites");
}
export function gatewayBin(): string {
  try {
    return fileURLToPath(import.meta.resolve("@frites/gateway"));
  } catch {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "gateway", "dist", "index.js"),
      join(here, "..", "..", "..", "gateway", "dist", "index.js"),
      join(here, "..", "..", "apps", "gateway", "dist", "index.js"),
      join(here, "..", "..", "apps", "gateway", "src", "index.ts"),
    ].map((p) => resolve(p));
    return candidates.find(existsSync) ?? candidates[0]!;
  }
}

export async function runGateway(argv: string[]): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") env.FRITES_GATEWAY_PORT = argv[++i];
    else if (argv[i] === "--host") env.FRITES_GATEWAY_HOST = argv[++i];
  }
  const child = spawn(process.execPath, [gatewayBin()], { stdio: "inherit", env });
  await new Promise<void>((resolveRun, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exitCode = code ?? 1;
      resolveRun();
    });
  });
}
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function systemdQuote(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function carriedEnv(): Array<[string, string]> {
  const env: Array<[string, string]> = [
    ["PATH", process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin"],
    ["HOME", homedir()],
  ];
  for (const k of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "FRITES_PASS_API_KEYS",
  ]) {
    if (process.env[k]) env.push([k, process.env[k]!]);
  }
  return env;
}

function buildPlist(port: number): string {
  const gateway = gatewayBin();
  const env: Array<[string, string]> = [...carriedEnv(), ["FRITES_GATEWAY_PORT", String(port)]];
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
    <string>${escapeXml(gateway)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(homedir())}</string>
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

function buildSystemdUnit(port: number): string {
  const env = [...carriedEnv(), ["FRITES_GATEWAY_PORT", String(port)] as [string, string]]
    .map(([k, v]) => `Environment="${k}=${systemdQuote(v)}"`)
    .join("\n");
  return `[Unit]
Description=frites gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=${homedir()}
ExecStart=${process.execPath} ${gatewayBin()}
Restart=always
RestartSec=2
${env}
StandardOutput=append:${join(logDir(), "gateway.log")}
StandardError=append:${join(logDir(), "gateway.err")}

[Install]
WantedBy=default.target
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
function systemctl(args: string[], stdio: "ignore" | "inherit" = "ignore"): void {
  execFileSync("systemctl", ["--user", ...args], { stdio });
}
function enableSystemdUserUnit(unit: string): void {
  systemctl(["daemon-reload"]);
  systemctl(["enable", "--now", unit], "inherit");
}
function disableSystemdUserUnit(unit: string): void {
  try {
    systemctl(["disable", "--now", unit], "inherit");
  } catch {
    /* not installed or not running */
  }
  try {
    systemctl(["daemon-reload"]);
  } catch {
    /* systemd unavailable */
  }
}

export async function runService(argv: string[]): Promise<void> {
  const os = platform();
  if (os !== "darwin" && os !== "linux") {
    console.error("frites service install currently supports macOS launchd and Linux systemd --user. Use `frites gateway` to run in the foreground on this OS.");
    process.exit(1);
  }
  const sub = argv[0] ?? "";
  let port = 6767;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--port") port = Number(argv[++i]);
  }
  const plist = plistPath();
  const unit = systemdUnitPath();

  switch (sub) {
    case "install": {
      // A from-source checkout won't have the gateway compiled yet; the service runs plain
      // `node dist/index.js`, so registering it now would only crash-loop (MODULE_NOT_FOUND)
      // while reporting success. Fail loudly with the fix instead of writing a doomed unit.
      const gateway = gatewayBin();
      if (!existsSync(gateway)) {
        console.error(
          `Gateway not built — ${gateway} is missing.\n` +
            "Run `pnpm build` first, then `frites install`.",
        );
        process.exit(1);
      }
      mkdirSync(logDir(), { recursive: true });
      if (os === "darwin") {
        mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
        writeFileSync(plist, buildPlist(port));
        unloadAgent(plist);
        loadAgent(plist);
        console.log(`✓ frites gateway installed as a macOS launchd service (${LABEL}).`);
      } else {
        mkdirSync(systemdUserDir(), { recursive: true });
        writeFileSync(unit, buildSystemdUnit(port));
        disableSystemdUserUnit(SYSTEMD_UNIT);
        enableSystemdUserUnit(SYSTEMD_UNIT);
        console.log(`✓ frites gateway installed as a Linux systemd user service (${SYSTEMD_UNIT}).`);
      }
      console.log(
        `  Running on http://127.0.0.1:${port} — auto-starts on login, restarts on crash, idle = $0.`,
      );
      console.log("\nPoint Claude Code at it — add to ~/.claude/settings.json:");
      console.log(
        `  { "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:${port}", "ANTHROPIC_AUTH_TOKEN": "frites" } }`,
      );
      console.log(
        `\nManage: frites status | restart | logs | stop   ·   logs: ${join(logDir(), "gateway.log")}`,
      );
      return;
    }
    case "uninstall": {
      if (os === "darwin") {
        unloadAgent(plist);
        if (existsSync(plist)) rmSync(plist);
      } else {
        disableSystemdUserUnit(SYSTEMD_UNIT);
        if (existsSync(unit)) rmSync(unit);
        systemctl(["daemon-reload"]);
      }
      console.log("✓ frites gateway service removed.");
      return;
    }
    case "restart": {
      if (os === "darwin") {
        if (!existsSync(plist)) {
          console.error("Not installed. Run: frites install");
          process.exit(1);
        }
        unloadAgent(plist);
        loadAgent(plist);
      } else {
        if (!existsSync(unit)) {
          console.error("Not installed. Run: frites install");
          process.exit(1);
        }
        systemctl(["restart", SYSTEMD_UNIT], "inherit");
      }
      console.log("✓ frites gateway restarted.");
      return;
    }
    case "status": {
      console.log(os === "darwin"
        ? `plist:   ${existsSync(plist) ? plist : "(not installed)"}`
        : `unit:    ${existsSync(unit) ? unit : "(not installed)"}`);
      try {
        if (os === "darwin") {
          const list = execFileSync("launchctl", ["list"], { encoding: "utf8" });
          const line = list.split("\n").find((l) => l.includes(LABEL));
          console.log(`launchd: ${line ? line.trim() : "not loaded"}`);
        } else {
          const active = execFileSync("systemctl", ["--user", "is-active", SYSTEMD_UNIT], { encoding: "utf8" }).trim();
          const enabled = execFileSync("systemctl", ["--user", "is-enabled", SYSTEMD_UNIT], { encoding: "utf8" }).trim();
          console.log(`systemd: ${active} / ${enabled}`);
        }
      } catch {
        console.log(os === "darwin" ? "launchd: not loaded" : "systemd: not loaded");
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
      console.error("usage: frites service <install|uninstall|restart|status|logs> [--port N]");
      process.exit(1);
  }
}

// ── `frites logs` — tail the gateway's detailed debug log ──

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
        `service with 'frites service install', then check 'frites service status'.`,
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
