import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// NEXT_PUBLIC_* values are baked into the static bundle at `next build` time.
// Load the same .env files (highest precedence first) as Next.js does so the
// build process is independent of the directory the script is invoked from.
// `process.env` keeps precedence over file values, matching Next's load order.
const envFiles = [
  ".env.production.local",
  ".env.local",
  ".env.production",
  ".env",
]
  .map((name) => resolve(REPO_ROOT, name))
  .filter(existsSync);

if (envFiles.length === 0) {
  console.error(
    `[build] Fatal: no .env / .env.production found at ${REPO_ROOT}. ` +
      "NEXT_PUBLIC_* variables cannot be inlined without them. Aborting.",
  );
  process.exit(1);
}

dotenv.config({ path: envFiles });

// Fail fast instead of silently packaging a desktop app stuck on the
// "Supabase غير مُعد" fallback screen.
const REQUIRED_PUBLIC_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
];
const missing = REQUIRED_PUBLIC_VARS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(
    `[build] Fatal: missing required NEXT_PUBLIC_* variables: ${missing.join(", ")}. ` +
      "They must be defined in .env / .env.production before the bundle is compiled. Aborting.",
  );
  process.exit(1);
}

// Force a fresh compile so a stale `.next` cache can never reuse chunks built
// without the env vars inlined. Also guarantees we never package a leftover
// `out/` if `next build` fails part way.
for (const dir of [".next", "out"]) {
  const target = resolve(REPO_ROOT, dir);
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
}

console.log(`[build] Next build…`);
execSync("npm run build", { cwd: REPO_ROOT, env: process.env, stdio: "inherit" });

// Verify the variables were physically baked into the exported JS bundles.
// Abort before packaging if anything is missing.
function verifyEnvBaked() {
  const chunksDir = resolve(REPO_ROOT, "out", "_next", "static", "chunks");
  let chunkFiles;
  try {
    chunkFiles = readdirSync(chunksDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => resolve(chunksDir, name));
  } catch {
    throw new Error(
      `[build] out/_next/static/chunks not found under ${REPO_ROOT}/out — static export failed.`,
    );
  }

  const contents = chunkFiles.map((file) => readFileSync(file, "utf8"));
  for (const key of REQUIRED_PUBLIC_VARS) {
    const value = process.env[key];
    const probe = value.includes("://") ? new URL(value).hostname : value.slice(0, 24);
    if (!contents.some((text) => text.includes(probe))) {
      throw new Error(
        `[build] ${key} was NOT found in any static chunk under ${REPO_ROOT}/out. ` +
          "The value was not baked into the bundle. Aborting to avoid packaging a broken app.",
      );
    }
    console.log(`[build] verified ${key} baked into the static bundle`);
  }
}

verifyEnvBaked();

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = `dist-final-${stamp}`;

console.log(`[build] electron-builder → ${outDir}`);
execSync(
  `npx electron-builder --win nsis --config.directories.output="${outDir}"`,
  { cwd: REPO_ROOT, env: process.env, stdio: "inherit" },
);

console.log(`[build] Done. Installer in ${outDir}/`);