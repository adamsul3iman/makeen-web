import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TARGET_ROOT = "E:\\MAKEEN_WORKSPACE";
const SOURCE_TARGET = path.join(TARGET_ROOT, "Source_Code");
const RELEASE_TARGET = path.join(TARGET_ROOT, "Print_Agent_Release");
const SOURCE_ARCHIVE = path.join(SOURCE_TARGET, "makeen-pos-source.zip");
const RESTORE_GUIDE = path.join(TARGET_ROOT, "HOW_TO_RESTORE.txt");
const PRINT_AGENT_ROOT = path.join(PROJECT_ROOT, "print-agent");
const PRINT_AGENT_RELEASE = path.join(PRINT_AGENT_ROOT, "release");

const RELEASE_FILES = [
  "MAKEEN-Printer.exe",
  "install.bat",
  "uninstall.bat",
  "config.example.json",
];

const EXCLUDED_DIRECTORY_NAMES = new Set(["node_modules", ".next", ".git"]);
const EXCLUDED_GENERATED_DIRECTORIES = new Set([
  "print-agent/.build-temp",
  "print-agent/release",
]);

function assertUsbDriveAvailable() {
  const driveRoot = path.parse(TARGET_ROOT).root;
  if (!fs.existsSync(driveRoot)) {
    throw new Error(`USB drive not found at ${driveRoot}. Insert the E: drive and try again.`);
  }
}

function buildPrintAgent() {
  console.log("\n[1/5] Building MAKEEN Print Agent...");
  if (process.platform === "win32") {
    execFileSync(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", [
      "/d",
      "/s",
      "/c",
      "npm run build:exe",
    ], {
      cwd: PRINT_AGENT_ROOT,
      stdio: "inherit",
    });
    return;
  }

  execFileSync("npm", ["run", "build:exe"], {
    cwd: PRINT_AGENT_ROOT,
    stdio: "inherit",
  });
}

function prepareUsbDirectories() {
  console.log("\n[2/5] Preparing USB workspace...");
  fs.mkdirSync(SOURCE_TARGET, { recursive: true });
  fs.rmSync(RELEASE_TARGET, { recursive: true, force: true });
  fs.mkdirSync(RELEASE_TARGET, { recursive: true });
}

function copyPrintAgentRelease() {
  console.log("\n[3/5] Copying print-agent release files...");

  for (const fileName of RELEASE_FILES) {
    const source = path.join(PRINT_AGENT_RELEASE, fileName);
    if (!fs.existsSync(source)) {
      throw new Error(`Required print-agent release file is missing: ${source}`);
    }

    fs.copyFileSync(source, path.join(RELEASE_TARGET, fileName));
    console.log(`  Copied ${fileName}`);
  }
}

function normalizeArchivePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function collectSourceFiles() {
  const files = [];

  function visit(absoluteDirectory, relativeDirectory = "") {
    const entries = fs.readdirSync(absoluteDirectory, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const archivePath = normalizeArchivePath(relativePath);
      const absolutePath = path.join(absoluteDirectory, entry.name);

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue;
        if (EXCLUDED_GENERATED_DIRECTORIES.has(archivePath.toLowerCase())) continue;
        visit(absolutePath, relativePath);
        continue;
      }

      if (entry.isFile()) {
        files.push(archivePath);
        continue;
      }

      if (entry.isSymbolicLink() && fs.statSync(absolutePath).isFile()) {
        files.push(archivePath);
      }
    }
  }

  visit(PROJECT_ROOT);

  for (const fileName of [".env", ".env.local"]) {
    if (fs.existsSync(path.join(PROJECT_ROOT, fileName)) && !files.includes(fileName)) {
      throw new Error(`Required environment file was not selected for backup: ${fileName}`);
    }
  }

  const forbiddenPath = files.find((file) =>
    file.split("/").some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment.toLowerCase())),
  );
  if (forbiddenPath) {
    throw new Error(`Excluded directory leaked into the backup manifest: ${forbiddenPath}`);
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function createSourceArchive() {
  console.log("\n[4/5] Creating source-code archive...");
  const files = collectSourceFiles();
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "makeen-usb-export-"));
  const manifestPath = path.join(temporaryDirectory, "manifest.json");
  const powerShellScriptPath = path.join(temporaryDirectory, "create-archive.ps1");

  fs.rmSync(SOURCE_ARCHIVE, { force: true });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        sourceRoot: PROJECT_ROOT,
        destination: SOURCE_ARCHIVE,
        files,
        requiredEnvironmentFiles: [".env", ".env.local"].filter((fileName) =>
          fs.existsSync(path.join(PROJECT_ROOT, fileName)),
        ),
      },
      null,
      2,
    ),
    "utf8",
  );

  const powerShellScript = String.raw`
param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$archive = [System.IO.Compression.ZipFile]::Open(
  $manifest.destination,
  [System.IO.Compression.ZipArchiveMode]::Create
)

try {
  foreach ($relativePath in $manifest.files) {
    $windowsRelativePath = $relativePath.Replace("/", [System.IO.Path]::DirectorySeparatorChar)
    $sourcePath = Join-Path $manifest.sourceRoot $windowsRelativePath
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $sourcePath,
      $relativePath,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
}
finally {
  $archive.Dispose()
}

$verificationArchive = [System.IO.Compression.ZipFile]::OpenRead($manifest.destination)
try {
  $entryNames = @($verificationArchive.Entries | ForEach-Object { $_.FullName })
  $forbidden = @("node_modules", ".next", ".git")

  foreach ($entryName in $entryNames) {
    foreach ($segment in ($entryName -split "/")) {
      if ($forbidden -contains $segment) {
        throw "Excluded directory found in archive: $entryName"
      }
    }
  }

  foreach ($environmentFile in $manifest.requiredEnvironmentFiles) {
    if ($entryNames -notcontains $environmentFile) {
      throw "Required environment file missing from archive: $environmentFile"
    }
  }

  Write-Output "Archived $($entryNames.Count) source files."
}
finally {
  $verificationArchive.Dispose()
}
`;

  fs.writeFileSync(powerShellScriptPath, powerShellScript, "utf8");

  const windowsPowerShell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  try {
    execFileSync(
      windowsPowerShell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        powerShellScriptPath,
        "-ManifestPath",
        manifestPath,
      ],
      { stdio: "inherit" },
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const archiveSizeMb = (fs.statSync(SOURCE_ARCHIVE).size / 1024 / 1024).toFixed(1);
  console.log(`  Created makeen-pos-source.zip (${archiveSizeMb} MB)`);
}

function writeRestoreGuide() {
  console.log("\n[5/5] Writing Arabic restore instructions...");

  const instructions = `كيفية استعادة مشروع MAKEEN على جهاز جديد
========================================

1. ثبّت برنامج Node.js من الموقع الرسمي:
   https://nodejs.org/

2. فك ضغط الملف التالي إلى مجلد على الجهاز الجديد:
   Source_Code\\makeen-pos-source.zip

3. افتح Terminal أو PowerShell داخل المجلد الذي تم فك الضغط إليه، ثم شغّل:
   npm install

4. بعد اكتمال تثبيت الحزم، شغّل بيئة التطوير بالأمر:
   npm run dev

ملفات وكيل الطباعة الجاهزة موجودة في:
Print_Agent_Release

مهم: النسخة الاحتياطية تحتوي على ملفات البيئة مثل .env و .env.local عند وجودها،
وقد تحتوي هذه الملفات على بيانات سرية. احتفظ بذاكرة USB في مكان آمن.
`;

  fs.writeFileSync(RESTORE_GUIDE, `\uFEFF${instructions}`, "utf8");
  console.log("  Created HOW_TO_RESTORE.txt");
}

function main() {
  if (process.platform !== "win32") {
    throw new Error("USB export currently supports Windows only.");
  }

  assertUsbDriveAvailable();
  buildPrintAgent();
  prepareUsbDirectories();
  copyPrintAgentRelease();
  createSourceArchive();
  writeRestoreGuide();

  console.log("\nMAKEEN workspace export completed successfully.");
  console.log(`Destination: ${TARGET_ROOT}`);
}

try {
  main();
} catch (error) {
  console.error("\nMAKEEN USB export failed.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
