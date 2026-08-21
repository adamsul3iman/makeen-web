#!/usr/bin/env node
/**
 * scripts/start-live.mjs — start `next start` in LIVE Supabase mode.
 *
 * `next start` normally loads `.env.production`, which blanks the Supabase
 * keys and forces mock mode. Real process.env wins over every .env file, so
 * this wrapper injects the keys from `.env` into process.env before spawning
 * Next. Usage: node scripts/start-live.mjs [port]
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "start";
const port = process.argv[3] ?? "3101";

for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if (v.length >= 2) {
    const f = v[0];
    const l = v[v.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) v = v.slice(1, -1);
  }
  if (!(k in process.env)) process.env[k] = v;
}

const nextBin = join(ROOT, "node_modules", "next", "dist", "bin", "next");
const child = spawn(
  process.execPath,
  [nextBin, command, "-p", port],
  { cwd: ROOT, stdio: "inherit", env: process.env },
);
child.on("exit", (code) => process.exit(code ?? 0));
