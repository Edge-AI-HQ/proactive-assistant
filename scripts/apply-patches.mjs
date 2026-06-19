import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const patchDir = join(repoRoot, "patches");
const nodeModulesDir = join(repoRoot, "node_modules");
const patchPackageBin = join(
  nodeModulesDir,
  ".bin",
  process.platform === "win32" ? "patch-package.cmd" : "patch-package",
);

function packageNameFromPatch(filename) {
  const withoutSuffix = filename.replace(/\.patch$/, "");
  const parts = withoutSuffix.split("+");
  if (parts[0]?.startsWith("@")) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function packagePath(packageName) {
  return join(nodeModulesDir, ...packageName.split("/"));
}

if (!existsSync(patchDir)) {
  process.exit(0);
}

const patchFiles = readdirSync(patchDir).filter((name) => name.endsWith(".patch"));
if (patchFiles.length === 0) {
  process.exit(0);
}

const applicable = [];
for (const filename of patchFiles) {
  const packageName = packageNameFromPatch(filename);
  if (existsSync(packagePath(packageName))) {
    applicable.push(filename);
  } else {
    console.log(`[patch-package] skipping ${filename}: ${packageName} is not installed here`);
  }
}

if (applicable.length === 0) {
  console.log("[patch-package] no applicable patches for this install context");
  process.exit(0);
}

let filteredPatchDir = patchDir;
let patchDirArg = "patches";
if (applicable.length !== patchFiles.length) {
  filteredPatchDir = mkdtempSync(join(repoRoot, ".patch-package-filtered-"));
  patchDirArg = relative(repoRoot, filteredPatchDir);
  for (const filename of applicable) {
    copyFileSync(join(patchDir, filename), join(filteredPatchDir, filename));
  }
}

try {
  const result = spawnSync(
    existsSync(patchPackageBin) ? patchPackageBin : "patch-package",
    ["--patch-dir", patchDirArg],
    {
      cwd: repoRoot,
      env: process.env,
      shell: process.platform === "win32",
      stdio: "inherit",
    },
  );

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
} finally {
  if (filteredPatchDir !== patchDir) {
    rmSync(filteredPatchDir, { recursive: true, force: true });
  }
}
