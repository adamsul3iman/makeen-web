import { existsSync, rmSync } from "node:fs";

const TARGET = "dist-final";
const MAX_RETRIES = 6;
const RETRY_MS = 800;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!existsSync(TARGET)) {
    console.log("[clean] dist-final does not exist, nothing to do.");
    return;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      rmSync(TARGET, { recursive: true, force: true });
      console.log(`[clean] Removed dist-final (attempt ${attempt}).`);
      return;
    } catch (err) {
      if (err.code === "EBUSY" || err.code === "EPERM") {
        console.log(
          `[clean] Attempt ${attempt}/${MAX_RETRIES} — dist-final locked (${err.code}), waiting ${RETRY_MS}ms...`
        );
        await sleep(RETRY_MS);
        continue;
      }
      throw err;
    }
  }

  console.warn(
    "[clean] WARNING: dist-final is locked by another process (antivirus, search indexer, etc.)."
  );
  console.warn(
    "[clean] The build will continue — if it fails, restart your PC or exclude the project folder from Windows Defender/Search."
  );
}

main();
