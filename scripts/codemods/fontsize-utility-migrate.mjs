#!/usr/bin/env node
/**
 * 字号 utility 迁移 codemod：把 `text-[Npx]` 魔法数替换成 typeScale 的 size-only
 * tailwind 工具类(text-body 等)。纯 className 字符串替换(非结构改写),逐值等价
 * (utility size-only,不动 leading/tracking)。
 *
 * 映射:精确档逐值对应;off-scale(11.5/12.5/9/14/18/19/10.5/16/13.5/9.5)四舍五入
 * 到最近档(全部 ≤1px,plan §六.1「合并轻微像素变化,设计已接受容差」)。
 * display 档(28/30/34px)**不在此**——大标题走 Text primitive variant="display"。
 *
 * 用法：node scripts/codemods/fontsize-utility-migrate.mjs [--dry]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const DRY = process.argv.includes("--dry");

// text-[Npx] → text-<typeScale 档>。键按字符串精确匹配(text-[11px] 不会误伤 text-[11.5px])。
const MAP = {
  "text-[9px]": "text-micro",
  "text-[9.5px]": "text-micro",
  "text-[10px]": "text-micro",
  "text-[10.5px]": "text-micro",
  "text-[11px]": "text-caption",
  "text-[11.5px]": "text-caption",
  "text-[12px]": "text-label",
  "text-[12.5px]": "text-label",
  "text-[13px]": "text-bodySm",
  "text-[13.5px]": "text-bodySm",
  "text-[14px]": "text-body",
  "text-[15px]": "text-body",
  "text-[16px]": "text-body",
  "text-[17px]": "text-subheading",
  "text-[18px]": "text-subheading",
  "text-[19px]": "text-heading",
  "text-[20px]": "text-heading",
  "text-[24px]": "text-title",
  // 28 / 30 / 34px(display 档)故意不映射 → 走 Text primitive。
};

const ROOTS = [
  "packages/ui-web/src",
  "proactive-ai-frontend/src",
  "apps/web/src",
];

// 用 git 列出受版本控制的 .ts/.tsx(避开 node_modules/dist)。
const files = ROOTS.flatMap((root) =>
  execSync(`git ls-files '${root}/**/*.ts' '${root}/**/*.tsx'`, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean),
);

const counts = {};
let changedFiles = 0;
let totalRepl = 0;

for (const file of files) {
  let src = readFileSync(file, "utf8");
  let fileChanged = false;
  for (const [from, to] of Object.entries(MAP)) {
    if (!src.includes(from)) continue;
    const n = src.split(from).length - 1;
    src = src.split(from).join(to);
    counts[from] = (counts[from] || 0) + n;
    totalRepl += n;
    fileChanged = true;
  }
  if (fileChanged) {
    changedFiles++;
    if (!DRY) writeFileSync(file, src);
  }
}

console.log(DRY ? "=== DRY RUN ===" : "=== APPLIED ===");
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v.toString().padStart(4)}  ${k} → ${MAP[k]}`);
}
console.log(`总计 ${totalRepl} 处替换,${changedFiles} 文件。`);

// 残留检查(应只剩 display 档 28/30/34)。
const remaining = files
  .flatMap((f) => (readFileSync(f, "utf8").match(/text-\[[0-9.]+px\]/g) || []))
  .reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {});
const leftover = Object.entries(remaining).sort((a, b) => b[1] - a[1]);
if (leftover.length) {
  console.log("\n残留 text-[Npx](预期仅 display 档 28/30/34):");
  for (const [k, v] of leftover) console.log(`  ${v.toString().padStart(4)}  ${k}`);
}
