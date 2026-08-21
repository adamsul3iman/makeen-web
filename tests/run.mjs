/**
 * End-to-end verification orchestrator.
 *
 *   1. Builds the Next app (unless --skip-build and a build exists).
 *   2. Starts `next start` on an ephemeral port.
 *   3. Runs the API health sweep against it (mock mode by default: no Supabase keys).
 *   4. Stops the server.
 *   5. Runs the store-workflow + route-validation suite via tsx.
 *
 * Exits non-zero on the first failing stage.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.VERIFY_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const skipBuild = process.argv.includes("--skip-build");
const forceBuild = process.argv.includes("--build");
const liveMode = process.argv.includes("--live");
const isWin = process.platform === "win32";
const childEnv = liveMode
  ? process.env
  : {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      POS_FORCE_MOCK: "1",
      // Mock mode normally simulates a 500ms sync drain round trip (realistic
      // for offline-first dev). Zero it during the automated verify so the
      // perf benchmark measures the handler's own cost, not the simulation.
      POS_SYNC_MOCK_LATENCY_MS: "0",
    };

const npmCmd = isWin ? "npm.cmd" : "npm";
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");

let failed = false;

function runSync(cmd, args, label) {
  console.log(`\n==> ${label}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: root, shell: isWin, env: childEnv });
  if (res.status !== 0) {
    console.error(`[verify] ${label} failed (exit ${res.status})`);
    process.exit(1);
  }
}

async function waitForServer(proc) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    if (proc.exitCode !== null) {
      throw new Error("next start exited early");
    }
    try {
      const res = await fetch(`${BASE_URL}/api/catalog`, { headers: { "x-pos-store-id": "store-main" } });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become ready in time");
}

function stopServer(proc) {
  if (proc.exitCode !== null) return;
  if (isWin) {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    proc.kill("SIGTERM");
  }
}

async function run(cmd, args, label) {
  console.log(`\n==> ${label}`);
  const proc = spawn(cmd, args, { stdio: "inherit", cwd: root, shell: isWin, env: childEnv });
  const code = await new Promise((resolve) => {
    proc.on("exit", (c) => resolve(c ?? 1));
    proc.on("error", (err) => {
      console.error(`[verify] spawn error: ${err.message}`);
      resolve(1);
    });
  });
  return code;
}

async function main() {
  if (forceBuild || !skipBuild || !existsSync(join(root, ".next", "BUILD_ID"))) {
    runSync(npmCmd, ["run", "build"], "next build");
  }

  // Stage 2: boot the server.
  const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    env: childEnv,
  });
  try {
    await waitForServer(server);
  } catch (err) {
    console.error(`[verify] ${err.message}`);
    stopServer(server);
    process.exit(1);
  }

  // Stage 3: API health sweep.
  const apiCode = await run(npmCmd, ["run", "verify:api"], "api health sweep");

  // Stage 3b: API latency benchmark (needs the live server).
  const perfCode = await run(npmCmd, ["run", "verify:perf"], "api latency benchmark");

  stopServer(server);
  if (apiCode !== 0 || perfCode !== 0) failed = true;

  // Stage 4: signed-session and tenant-boundary regression checks.
  const securityCode = await run(npmCmd, ["run", "verify:security"], "security session suite");
  if (securityCode !== 0) failed = true;

  // Stage 5: local printer, scanner and cash-drawer settings/drivers.
  const hardwareCode = await run(npmCmd, ["run", "verify:hardware"], "hardware workflow suite");
  if (hardwareCode !== 0) failed = true;

  // Stage 6: enterprise stress, concurrency and precision audit.
  const stressCode = await run(npmCmd, ["run", "verify:stress"], "stress + concurrency + precision suite");
  if (stressCode !== 0) failed = true;

  // Stage 7: store workflow + route validation.
  const storeCode = await run(npmCmd, ["run", "verify:store"], "store workflow suite");
  if (storeCode !== 0) failed = true;

  // Stage 8: shortage radar + emergency-flag pipeline.
  const shortagesCode = await run(npmCmd, ["run", "verify:shortages"], "shortage radar suite");
  if (shortagesCode !== 0) failed = true;

  if (failed) {
    console.error("\n[verify] FAILED");
    process.exit(1);
  }
  console.log("\n[verify] ALL GREEN");
}

void main();
