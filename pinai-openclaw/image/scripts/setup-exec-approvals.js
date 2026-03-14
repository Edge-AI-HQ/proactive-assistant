/**
 * Configure OpenClaw exec-approvals for headless mode.
 *
 * OpenClaw defaults to interactive confirmation for bash/exec tools.
 * In our headless (no human operator) container, we must pre-approve all
 * exec actions; otherwise the agent hangs forever waiting for user input.
 *
 * Writes to /app/.openclaw/exec-approvals.json (the single state directory).
 * /root/.openclaw is a symlink to /app/.openclaw (set up in the Dockerfile),
 * so OpenClaw finds this file regardless of which home-dir path it resolves.
 */
const fs = require("fs");
const path = require("path");

const approvalPath = "/app/.openclaw/exec-approvals.json";
const socketPath = "/app/.openclaw/exec-approvals.sock";

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};

const existing = readJson(approvalPath);
const merged = {
  ...(existing && typeof existing === "object" ? existing : {}),
  version: 1,
  socket:
    (existing && typeof existing.socket === "object" && existing.socket) || {
      path: socketPath,
    },
  defaults: {
    ...((existing && typeof existing.defaults === "object" && existing.defaults) || {}),
    security: "full",
    ask: "off",
    askFallback: "full",
    autoAllowSkills: true,
  },
};

fs.mkdirSync(path.dirname(approvalPath), { recursive: true });
fs.writeFileSync(approvalPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
