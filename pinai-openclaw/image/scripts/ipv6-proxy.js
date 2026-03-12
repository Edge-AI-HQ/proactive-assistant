/**
 * Bridges [::]:port -> 127.0.0.1:port so Fly Proxy (IPv6-only) can reach
 * IPv4-only listeners inside the container.
 *
 * Usage: node ipv6-proxy.js <label> <port>
 */
const net = require("net");

const label = process.argv[2] || "ipv6-proxy";
const port = Number(process.argv[3]);

if (!port || !Number.isFinite(port)) {
  console.error(`Usage: node ipv6-proxy.js <label> <port>`);
  process.exit(1);
}

const server = net.createServer((incoming) => {
  const outgoing = net.connect({ host: "127.0.0.1", port });
  incoming.pipe(outgoing);
  outgoing.pipe(incoming);
  const cleanup = () => { incoming.destroy(); outgoing.destroy(); };
  incoming.on("error", cleanup);
  outgoing.on("error", cleanup);
});

server.on("error", (err) => {
  console.error(`[${label}] fatal`, err);
  process.exit(1);
});

server.listen({ host: "::", port, ipv6Only: true }, () => {
  console.log(`[${label}] [::]:${port} -> 127.0.0.1:${port}`);
});
