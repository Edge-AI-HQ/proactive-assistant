#!/usr/bin/env node
import { runCli } from "./cli.js";

const result = await runCli(process.argv.slice(2));

if (result.stdout) {
  console.log(JSON.stringify(result.stdout, null, 2));
}

process.exit(result.exitCode);
