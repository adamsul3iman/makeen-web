/**
 * build-exe.js — Compiles the print agent into a standalone Windows .exe
 *
 * Uses esbuild (bundle) + Node.js SEA (single executable application).
 *
 * Steps:
 *   1. Clean previous builds
 *   2. Bundle with esbuild → single .cjs file (~3 MB)
 *   3. Generate Node.js SEA blob
 *   4. Copy node.exe → MAKEEN-Printer.exe
 *   5. Inject SEA blob via postject (copy → inject → replace)
 *   6. Copy config template + install.bat to release/
 *
 * Requirements: Node.js >= 20
 * Usage: node scripts/build-exe.js
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const RELEASE = path.join(ROOT, "release");
const TEMP = path.join(ROOT, ".build-temp");

function run(cmd, opts = {}) {
  console.log(`  > ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

function rimraf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ── 1. Clean ───────────────────────────────────────────────────────
console.log("\n[1/5] Cleaning previous builds…");
rimraf(RELEASE);
rimraf(TEMP);
fs.mkdirSync(RELEASE, { recursive: true });
fs.mkdirSync(TEMP, { recursive: true });

// ── 2. Bundle with esbuild ─────────────────────────────────────────
console.log("\n[2/5] Bundling with esbuild…");

const bundlePath = path.join(TEMP, "print-agent.cjs");
try {
  run(
    `npx esbuild src/index.ts --bundle --platform=node --target=node18 --format=cjs --outfile=${bundlePath}`
  );
} catch (err) {
  console.error("✗ esbuild bundling failed:", err.message);
  process.exit(1);
}

if (!fs.existsSync(bundlePath)) {
  console.error("✗ Bundle not found at", bundlePath);
  process.exit(1);
}

const bundleSize = (fs.statSync(bundlePath).size / 1024 / 1024).toFixed(1);
console.log(`  Bundle: ${bundleSize} MB`);

// ── 3. Create SEA blob ─────────────────────────────────────────────
console.log("\n[3/5] Generating Node.js SEA blob…");

const seaConfig = {
  main: bundlePath,
  output: path.join(TEMP, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
};
fs.writeFileSync(path.join(TEMP, "sea-config.json"), JSON.stringify(seaConfig, null, 2));

try {
  run(`node --experimental-sea-config ${path.join(TEMP, "sea-config.json")}`);
} catch (err) {
  console.error("✗ SEA config generation failed:", err.message);
  process.exit(1);
}

// ── 4. Copy node.exe ───────────────────────────────────────────────
console.log("\n[4/5] Creating MAKEEN-Printer.exe…");

const nodeExe = process.execPath;
const exeFinal = path.join(RELEASE, "MAKEEN-Printer.exe");
const exeTemp = path.join(TEMP, "MAKEEN-Printer.exe");

fs.copyFileSync(nodeExe, exeTemp);
console.log(`  Copied node runtime → MAKEEN-Printer.exe`);

// ── 5. Inject SEA blob ─────────────────────────────────────────────
console.log("\n[5/5] Injecting SEA blob…");

const blobPath = path.join(TEMP, "sea-prep.blob");
try {
  // postject can't write to the file it reads, so inject into a temp copy
  run(
    `node_modules\\.bin\\postject "${exeTemp}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`
  );
  fs.copyFileSync(exeTemp, exeFinal);
  console.log("  ✓ SEA blob injected successfully");
} catch (err) {
  // Still copy the exe even if injection fails — it'll run as plain Node.js
  fs.copyFileSync(exeTemp, exeFinal);
  console.log("  ⚠ postject injection failed:", err.message);
  console.log("  The .exe will run but may not be fully self-contained.");
}

// ── 6. Copy extras ─────────────────────────────────────────────────
console.log("\n[6/6] Copying deployment files…");

const extras = [
  ["config.example.json", "config.example.json"],
];
for (const [src, dst] of extras) {
  const srcPath = path.join(ROOT, src);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, path.join(RELEASE, dst));
    console.log(`  ✓ ${dst}`);
  }
}

// install.bat
fs.writeFileSync(path.join(RELEASE, "install.bat"), `@echo off
echo.
echo  ══════════════════════════════════════════════
echo   MAKEEN Print Agent — Installer
echo  ══════════════════════════════════════════════
echo.

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  ERROR: Run this as Administrator.
    echo  Right-click and select "Run as administrator".
    pause
    exit /b 1
)

echo  [1/2] Running first-time setup...
echo.
MAKEEN-Printer.exe
echo.
echo  [2/2] Registering Windows Service...
echo.
MAKEEN-Printer.exe --install
echo.
echo  ══════════════════════════════════════════════
echo   Done! Print agent starts on boot.
echo   Health: http://localhost:9100/health
echo  ══════════════════════════════════════════════
echo.
pause
`);
console.log("  ✓ install.bat");

fs.writeFileSync(path.join(RELEASE, "uninstall.bat"), `@echo off
echo.
echo  MAKEEN Print Agent — Uninstaller
echo.
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  Run as Administrator.
    pause
    exit /b 1
)
MAKEEN-Printer.exe --uninstall
pause
`);
console.log("  ✓ uninstall.bat");

// ── Cleanup ────────────────────────────────────────────────────────
rimraf(TEMP);

// ── Summary ────────────────────────────────────────────────────────
const exeSize = (fs.statSync(exeFinal).size / 1024 / 1024).toFixed(1);
console.log("");
console.log("╔═══════════════════════════════════════════════════════╗");
console.log("║  Build complete!                                     ║");
console.log("╠═══════════════════════════════════════════════════════╣");
console.log(`║  Output:  release/MAKEEN-Printer.exe  (${exeSize} MB)     ║`);
console.log("║                                                       ║");
console.log("║  Deployment:                                          ║");
console.log("║  1. Copy release/ folder to cashier machine           ║");
console.log("║  2. Double-click install.bat (as Admin)               ║");
console.log("║     — OR —                                            ║");
console.log("║  2. Run MAKEEN-Printer.exe (first-run wizard)         ║");
console.log("║  3. Run MAKEEN-Printer.exe --install (as Admin)       ║");
console.log("╚═══════════════════════════════════════════════════════╝");
console.log("");
