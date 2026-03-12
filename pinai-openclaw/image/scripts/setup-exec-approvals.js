/**
 * Configure OpenClaw exec-approvals for headless mode.
 *
 * OpenClaw defaults to interactive confirmation for bash/exec tools.
 * In our headless (no human operator) container, we must pre-approve all
 * exec actions; otherwise the agent hangs forever waiting for user input.
 *
 * Merges existing approval files (if any) and writes the final config to
 * /app/.openclaw/exec-approvals.json, then symlinks /root/.openclaw/ to it.
 */
const fs = require("fs");
const path = require("path");

const appPath = "/app/.openclaw/exec-approvals.json";
const rootPath = "/root/.openclaw/exec-approvals.json";
const socketPath = "/root/.openclaw/exec-approvals.sock";

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};

const base = readJson(appPath);
const root = readJson(rootPath);
const merged = {
  ...(root && typeof root === "object" ? root : {}),
  ...(base && typeof base === "object" ? base : {}),
  version: 1,
  socket:
    (base && typeof base.socket === "object" && base.socket) ||
    (root && typeof root.socket === "object" && root.socket) || {
      path: socketPath,
    },
  defaults: {
    ...((root && typeof root.defaults === "object" && root.defaults) || {}),
    ...((base && typeof base.defaults === "object" && base.defaults) || {}),
    security: "full",
    ask: "off",
    askFallback: "full",
    autoAllowSkills: true,
  },
};

fs.mkdirSync(path.dirname(appPath), { recursive: true });
fs.writeFileSync(appPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });

try {
  if (fs.existsSync(rootPath) || fs.lstatSync(path.dirname(rootPath)).isDirectory()) {
    try { fs.rmSync(rootPath, { force: true }); } catch {}
    fs.symlinkSync(appPath, rootPath);
  }
} catch {
  fs.copyFileSync(appPath, rootPath);
  fs.chmodSync(rootPath, 0o600);
}
