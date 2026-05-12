#!/usr/bin/env node
/**
 * Force iOS deployment targets in Capacitor-generated iOS files.
 *
 * `npx cap sync ios` rewrites the deployment target to the lowest value
 * declared by any installed Capacitor plugin (often 15.0 or 16.0).
 * `@pin/capacitor-ambient-ai` requires iOS 17 (HealthKit / SoundAnalysis
 * APIs), so any cap sync must be followed by this fix.
 *
 * Usage:
 *   node fix-deployment-target.mjs <path/to/project.pbxproj>
 *   node fix-deployment-target.mjs <path/to/project.pbxproj> --target 17.0
 *   node fix-deployment-target.mjs <path/to/project.pbxproj> --target 18.0 --package-swift <path/to/Package.swift>
 *
 * Idempotent: running on an already-fixed file is a no-op.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';

const TARGET_DEFAULT = '17.0';

function parseArgs() {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.error('usage: fix-deployment-target.mjs <project.pbxproj> [--target 17.0]');
    exit(2);
  }
  const filePath = resolve(args[0]);
  const targetIdx = args.indexOf('--target');
  const target = targetIdx >= 0 ? args[targetIdx + 1] : TARGET_DEFAULT;
  const packageSwiftIdx = args.indexOf('--package-swift');
  const packageSwiftPath = packageSwiftIdx >= 0 ? resolve(args[packageSwiftIdx + 1]) : undefined;
  return { filePath, target, packageSwiftPath };
}

function patchPbxproj(filePath, target) {
  const original = readFileSync(filePath, 'utf8');
  const re = /IPHONEOS_DEPLOYMENT_TARGET\s*=\s*[0-9.]+\s*;/g;
  const matches = original.match(re) ?? [];
  if (matches.length === 0) {
    console.warn(`[fix-deployment-target] no IPHONEOS_DEPLOYMENT_TARGET in ${filePath}`);
    return;
  }
  const replaced = original.replace(re, `IPHONEOS_DEPLOYMENT_TARGET = ${target};`);
  if (replaced === original) {
    console.log(`[fix-deployment-target] already at ${target} (${matches.length} entries)`);
    return;
  }
  writeFileSync(filePath, replaced, 'utf8');
  console.log(`[fix-deployment-target] set ${matches.length} entries to ${target} in ${filePath}`);
}

function patchPackageSwift(filePath, target) {
  if (!existsSync(filePath)) {
    console.warn(`[fix-deployment-target] no Package.swift at ${filePath}`);
    return;
  }
  const original = readFileSync(filePath, 'utf8');
  const re = /\.iOS\((?:\.v\d+|"[0-9.]+")\)/g;
  const matches = original.match(re) ?? [];
  if (matches.length === 0) {
    console.warn(`[fix-deployment-target] no .iOS platform in ${filePath}`);
    return;
  }
  const replaced = original.replace(re, `.iOS("${target}")`);
  if (replaced === original) {
    console.log(`[fix-deployment-target] Package.swift already at ${target} (${matches.length} entries)`);
    return;
  }
  writeFileSync(filePath, replaced, 'utf8');
  console.log(`[fix-deployment-target] set Package.swift platform to ${target} in ${filePath}`);
}

function main() {
  const { filePath, target, packageSwiftPath } = parseArgs();
  patchPbxproj(filePath, target);
  if (packageSwiftPath) {
    patchPackageSwift(packageSwiftPath, target);
  }
}

main();
