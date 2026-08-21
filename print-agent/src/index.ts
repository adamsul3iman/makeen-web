/**
 * MAKEEN POS — Local Print Agent (MAKEEN-Printer)
 *
 * Entry point. Handles three modes:
 *
 *   MAKEEN-Printer.exe                 — interactive first-run setup, then agent
 *   MAKEEN-Printer.exe --install       — register as Windows Service + start
 *   MAKEEN-Printer.exe --uninstall     — stop + remove Windows Service
 *   MAKEEN-Printer.exe --console       — force foreground (skip service check)
 */

import * as readline from "readline";
import { execSync } from "child_process";
import { loadConfig, saveConfig, hasValidConfig, getAgentDir } from "./config";
import { startListener } from "./listener";

const SERVICE_NAME = "MakeenPrinter";
const SERVICE_DISPLAY = "MAKEEN Print Agent";
const SERVICE_DESC = "Silent print agent for MAKEEN POS — bridges Supabase to local printers";

// ── Logging ─────────────────────────────────────────────────────────

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

function createLogger(configLevel: string) {
  const threshold = LOG_LEVELS[configLevel as keyof typeof LOG_LEVELS] ?? 1;
  return (level: string, msg: string, meta?: Record<string, unknown>) => {
    const lvl = LOG_LEVELS[level as keyof typeof LOG_LEVELS] ?? 1;
    if (lvl < threshold) return;
    const ts = new Date().toISOString();
    const suffix = meta ? " " + JSON.stringify(meta) : "";
    process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${msg}${suffix}\n`);
  };
}

const log = createLogger("info");

// ── First-run interactive setup ─────────────────────────────────────

function prompt(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

async function runSetupWizard(): Promise<void> {
  console.log("");
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║  MAKEEN Print Agent — First-Run Setup                 ║");
  console.log("║                                                       ║");
  console.log("║  Configure this cashier's print agent.                ║");
  console.log("║  A config.json will be created next to this .exe.     ║");
  console.log("╚═══════════════════════════════════════════════════════╝");
  console.log("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const supabaseUrl = await prompt(rl, "Supabase Project URL (https://xxx.supabase.co)");
    const supabaseKey = await prompt(rl, "Supabase Service Role Key");
    const terminalId = await prompt(rl, "Terminal ID (UUID from admin panel)");
    const thermalPrinter = await prompt(rl, "Thermal printer name", "Rongta RP80");
    const a4Printer = await prompt(rl, "A4 printer name", "HP LaserJet Pro");

    console.log("");
    console.log("  Saving config.json…");

    saveConfig({ supabaseUrl, supabaseKey, terminalId, thermalPrinter, a4Printer });

    console.log("  ✓ Configuration saved.");
    console.log("");
  } finally {
    rl.close();
  }
}

// ── Windows Service management (via sc.exe) ─────────────────────────

function installService(): void {
  const exePath = process.execPath;
  const agentDir = getAgentDir();

  console.log(`Installing service: ${SERVICE_DISPLAY}`);
  console.log(`Executable: ${exePath}`);
  console.log(`Working dir: ${agentDir}`);

  try {
    // Stop if already running
    try {
      execSync(`sc stop "${SERVICE_NAME}"`, { stdio: "pipe", timeout: 10000 });
      // Wait for stop
      execSync("ping -n 4 127.0.0.1 >nul", { stdio: "ignore" });
    } catch {
      // Service wasn't running — fine
    }

    // Delete if exists
    try {
      execSync(`sc delete "${SERVICE_NAME}"`, { stdio: "pipe", timeout: 10000 });
      execSync("ping -n 3 127.0.0.1 >nul", { stdio: "ignore" });
    } catch {
      // Didn't exist — fine
    }

    // Create the service
    // binPath must be the .exe with --console flag (service mode can't show a console)
    const binPath = `"${exePath}" --console`;
    execSync(
      `sc create "${SERVICE_NAME}" binPath= ${binPath} start= auto DisplayName= "${SERVICE_DISPLAY}"`,
      { stdio: "pipe", timeout: 15000 },
    );

    // Set description
    execSync(`sc description "${SERVICE_NAME}" "${SERVICE_DESC}"`, {
      stdio: "pipe",
      timeout: 10000,
    });

    // Set recovery: restart after 5s on failure, then 10s, then 30s
    execSync(`sc failure "${SERVICE_NAME}" reset= 86400 actions= restart/5000/restart/10000/restart/30000`, {
      stdio: "pipe",
      timeout: 10000,
    });

    // Start the service
    execSync(`sc start "${SERVICE_NAME}"`, { stdio: "pipe", timeout: 15000 });

    console.log("");
    console.log("✓ Service installed and started.");
    console.log(`  Name:    ${SERVICE_NAME}`);
    console.log(`  Display: ${SERVICE_DISPLAY}`);
    console.log(`  Status:  services.msc → ${SERVICE_DISPLAY}`);
    console.log(`  Health:  http://localhost:9100/health`);
    console.log("");
  } catch (err) {
    console.error("");
    console.error("✗ Service installation failed.");
    console.error("  Make sure you run this as Administrator.");
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    console.error("");
    console.error("  Alternative: run the .exe directly (no --install needed).");
    process.exit(1);
  }
}

function uninstallService(): void {
  console.log(`Uninstalling service: ${SERVICE_DISPLAY}`);

  try {
    execSync(`sc stop "${SERVICE_NAME}"`, { stdio: "pipe", timeout: 10000 });
    execSync("ping -n 4 127.0.0.1 >nul", { stdio: "ignore" });
  } catch {
    // Not running
  }

  try {
    execSync(`sc delete "${SERVICE_NAME}"`, { stdio: "pipe", timeout: 10000 });
    console.log("");
    console.log("✓ Service removed.");
    console.log("");
  } catch (err) {
    console.error("");
    console.error("✗ Uninstall failed. Make sure you run as Administrator.");
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    console.error("");
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function startAgent(): Promise<void> {
  const config = loadConfig();
  const agentLog = createLogger(config.logLevel);

  agentLog("info", "═══════════════════════════════════════════════════");
  agentLog("info", "  MAKEEN Print Agent — MAKEEN POS");
  agentLog("info", "═══════════════════════════════════════════════════");
  agentLog("info", `Terminal:      ${config.terminalId}`);
  agentLog("info", `Thermal:       ${config.thermalPrinter}`);
  agentLog("info", `A4:            ${config.a4Printer}`);
  agentLog("info", `Health:        http://0.0.0.0:${config.port}/health`);
  agentLog("info", `Supabase:      ${config.supabaseUrl}`);
  agentLog("info", "───────────────────────────────────────────────────");

  const handle = startListener(config, agentLog);

  const shutdown = async (signal: string) => {
    agentLog("info", `Received ${signal} — shutting down`);
    await handle.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => {
    agentLog("error", "Unhandled rejection", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  agentLog("info", "Agent started — waiting for print jobs");
}

async function main(): Promise<void> {
  const arg = process.argv[2]?.toLowerCase();

  // ── Service management modes ────────────────────────────────────
  if (arg === "--install") {
    if (!hasValidConfig()) {
      console.error("Error: config.json not found or incomplete.");
      console.error("Run the .exe without arguments first to set up.");
      process.exit(1);
    }
    installService();
    return;
  }

  if (arg === "--uninstall") {
    uninstallService();
    return;
  }

  // ── Normal / console mode ──────────────────────────────────────
  if (!hasValidConfig()) {
    // First run — run the interactive setup wizard
    await runSetupWizard();
    // After setup, start the agent
    await startAgent();
  } else {
    // Config exists — start the agent directly
    await startAgent();
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
