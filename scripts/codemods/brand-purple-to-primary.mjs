#!/usr/bin/env node
/**
 * 品牌紫统一 codemod：把散落的硬编码品牌紫收敛到 --primary token。
 * 用户拍板「并入 primary 统一」(S6)。
 *
 * 两个值合并到 primary(292 78% 63%):
 *   - hsl(292 78% 63%) / hsl(292,78%,63%)：= primary 精确值,**value-preserving**。
 *   - #E15CE6 / rgba(225,92,230,·) ≈ hsl(298 73% 63%)：卡片强调紫,微移到 292(用户已批准)。
 *
 * 保留(不动):
 *   - hsl(292 78% 55%) 暗变体(文字对比,无对应 token)。
 *   - hsl(330 ...) 渐变粉端。
 *   - index.css 的 :root 变量定义(--primary/--ring/--accent/--glow-primary 是真源)。
 *
 * 用法：node scripts/codemods/brand-purple-to-primary.mjs [--dry]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const DRY = process.argv.includes("--dry");

// 有序替换(tailwind 中括号先于裸 hsl,避免 [hsl(...)] 被裸规则截断)。
const RULES = [
  // tailwind arbitrary：from-[hsl(292,78%,63%)] → from-primary（前缀/opacity 在括号外,保留）
  [/\[hsl\(292,\s*78%,\s*63%\)\]/g, "primary"],
  // inline rgba(225,92,230,A) → hsl(var(--primary) / A)
  [/rgba\(225,\s*92,\s*230,\s*([0-9.]+)\)/g, "hsl(var(--primary) / $1)"],
  // inline #E15CE6
  [/#E15CE6/gi, "hsl(var(--primary))"],
  // inline hsl(292 78% 63% / A)（空格 + 斜杠 alpha）
  [/hsl\(292 78% 63% \/ ([0-9.]+)\)/g, "hsl(var(--primary) / $1)"],
  // inline hsl(292,78%,63%)（逗号,无 alpha）
  [/hsl\(292,\s*78%,\s*63%\)/g, "hsl(var(--primary))"],
  // inline hsl(292 78% 63%)（空格,无 alpha）
  [/hsl\(292 78% 63%\)/g, "hsl(var(--primary))"],
];

const ROOTS = ["packages/ui-web/src", "apps/web/src", "proactive-ai-frontend/src"];
const files = ROOTS.flatMap((root) =>
  execSync(`git ls-files '${root}/**/*.tsx' '${root}/**/*.ts'`, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean),
);

let totalFiles = 0;
let totalRepl = 0;
for (const file of files) {
  let src = readFileSync(file, "utf8");
  const before = src;
  let n = 0;
  for (const [re, to] of RULES) {
    src = src.replace(re, (...m) => {
      n++;
      return typeof to === "string" ? to.replace("$1", m[1] ?? "") : to;
    });
  }
  if (src !== before) {
    totalFiles++;
    totalRepl += n;
    console.log(`  ${String(n).padStart(3)}  ${file}`);
    if (!DRY) writeFileSync(file, src);
  }
}
console.log(`\n${DRY ? "DRY" : "APPLIED"}: ${totalRepl} 处替换, ${totalFiles} 文件。`);

// 残留检查(应只剩 55% 暗变体 + 330 粉)。
const leftover = files
  .flatMap((f) => (readFileSync(f, "utf8").match(/hsl\(292[, ]+78%[, ]+63%|#E15CE6|225,\s*92,\s*230/gi) || []))
  .length;
console.log(`残留 292/63% 或 #E15CE6 品牌紫: ${leftover}（预期 0）`);
