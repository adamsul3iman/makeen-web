/**
 * Configuration loader for the print agent.
 *
 * Path resolution works in both normal Node.js and pkg-bundled modes:
 * - Normal:   config.json lives next to dist/
 * - Bundled:  config.json lives next to MAKEEN-Printer.exe
 *
 * Priority: config.json > process.env > defaults.
 */

import * as fs from "fs";
import * as path from "path";

export interface AgentConfig {
  supabaseUrl: string;
  supabaseKey: string;
  terminalId: string;
  thermalPrinter: string;
  a4Printer: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

/**
 * In pkg bundles, __dirname points to a snapshot filesystem.
 * process.execPath (the .exe path) is the real location.
 * In normal Node.js, __dirname works fine.
 */
function getBaseDir(): string {
  // pkg sets process.pkg — the .exe directory is the real base
  if (process.pkg) {
    return path.dirname(process.execPath);
  }
  // Normal Node.js: go up from dist/ or src/ to the project root
  return path.resolve(__dirname, "..");
}

export function getConfigPath(): string {
  return path.join(getBaseDir(), "config.json");
}

export function getAgentDir(): string {
  return getBaseDir();
}

function loadJsonConfig(): Partial<AgentConfig> {
  const configFile = getConfigPath();
  try {
    if (!fs.existsSync(configFile)) return {};
    const raw = fs.readFileSync(configFile, "utf-8");
    const json = JSON.parse(raw);
    return {
      supabaseUrl: json.supabase_url ?? json.SUPABASE_URL,
      supabaseKey: json.supabase_key ?? json.SUPABASE_SERVICE_KEY ?? json.SUPABASE_KEY,
      terminalId: json.terminal_id ?? json.TERMINAL_ID,
      thermalPrinter: json.thermal_printer ?? json.THERMAL_PRINTER,
      a4Printer: json.a4_printer ?? json.A4_PRINTER,
      port: json.port ?? json.PORT,
    };
  } catch {
    return {};
  }
}

/**
 * Save a config.json next to the executable (or dist/ in dev mode).
 */
export function saveConfig(config: {
  supabaseUrl: string;
  supabaseKey: string;
  terminalId: string;
  thermalPrinter: string;
  a4Printer: string;
}): void {
  const payload = {
    supabase_url: config.supabaseUrl,
    supabase_key: config.supabaseKey,
    terminal_id: config.terminalId,
    thermal_printer: config.thermalPrinter,
    a4_printer: config.a4Printer,
    port: 9100,
    log_level: "info",
  };
  fs.writeFileSync(getConfigPath(), JSON.stringify(payload, null, 2), "utf-8");
}

/**
 * Check if a valid config.json exists with the minimum required fields.
 */
export function hasValidConfig(): boolean {
  const json = loadJsonConfig();
  return Boolean(json.supabaseUrl && json.supabaseKey && json.terminalId);
}

export function loadConfig(): AgentConfig {
  const json = loadJsonConfig();

  const requireVal = (name: string, fallback?: string): string => {
    const v = process.env[name] ?? fallback;
    if (!v) throw new Error(`Missing required config: ${name}. Run the setup wizard or edit config.json.`);
    return v;
  };

  return {
    supabaseUrl: requireVal("SUPABASE_URL", json.supabaseUrl),
    supabaseKey: requireVal("SUPABASE_SERVICE_KEY", json.supabaseKey),
    terminalId: requireVal("TERMINAL_ID", json.terminalId),
    thermalPrinter: process.env.THERMAL_PRINTER ?? json.thermalPrinter ?? "Rongta RP80",
    a4Printer: process.env.A4_PRINTER ?? json.a4Printer ?? "HP LaserJet Pro",
    port: Number(process.env.PORT ?? json.port ?? 9100),
    logLevel: (process.env.LOG_LEVEL ?? "info") as AgentConfig["logLevel"],
  };
}
