import { execSync } from "node:child_process";

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = `dist-final-${stamp}`;

console.log(`[build] Next build…`);
execSync("npm run build", { stdio: "inherit" });

console.log(`[build] electron-builder → ${outDir}`);
execSync(
  `npx electron-builder --win nsis --config.directories.output="${outDir}"`,
  { stdio: "inherit" }
);

console.log(`[build] Done. Installer in ${outDir}/`);
