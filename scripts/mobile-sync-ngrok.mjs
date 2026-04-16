import { spawn } from "node:child_process";

const port = Number.parseInt(process.env.MOBILE_SYNC_PORT ?? process.argv[2] ?? "3000", 10);
const inspectorUrl = "http://127.0.0.1:4040/api/tunnels";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findTunnel() {
  try {
    const response = await fetch(inspectorUrl);
    if (!response.ok) return null;
    const payload = await response.json();
    const tunnels = Array.isArray(payload?.tunnels) ? payload.tunnels : [];
    const exact = tunnels.find((tunnel) =>
      tunnel?.proto === "https" && String(tunnel?.config?.addr ?? "").endsWith(`:${port}`),
    );
    if (exact?.public_url) return exact.public_url;
    const fallback = tunnels.find((tunnel) => tunnel?.proto === "https");
    return fallback?.public_url ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const existing = await findTunnel();
  if (existing) {
    console.log(existing);
    console.error(`Using existing ngrok tunnel for localhost:${port}`);
    return;
  }

  const child = spawn("ngrok", ["http", String(port)], {
    stdio: "inherit",
  });

  const stop = (signal) => {
    if (!child.killed) child.kill(signal);
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(500);
    const tunnel = await findTunnel();
    if (tunnel) {
      console.error("");
      console.error(`Mobile Sync tunnel ready: ${tunnel}`);
      console.error("Paste this URL into the app's Mobile Sync Config -> API base URL.");
      console.error("");
      break;
    }
  }

  await new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
        resolve();
      } else {
        reject(new Error(`ngrok exited with code ${code ?? "unknown"}`));
      }
    });
    child.once("error", reject);
  });
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});
