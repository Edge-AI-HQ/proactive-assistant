#!/usr/bin/env node
import { runCli } from "./cli.js";
import { formatEnvelope, parseFormat } from "./output/format.js";

const argv = process.argv.slice(2);

const formatIdx = argv.indexOf("--format");
const format = parseFormat(
  formatIdx >= 0 ? argv[formatIdx + 1] : (argv.includes("--json") ? "json" : undefined),
);

const result = await runCli(argv);

if (result.stdout) {
  console.log(formatEnvelope(result.stdout, format));
}

process.exit(result.exitCode);
