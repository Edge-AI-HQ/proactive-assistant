/**
 * Codemod：把展示文本的 `text-[Npx]` 魔法数 + 内联字重迁移到 Text primitive。
 *
 * 设计 SSOT：docs/plans/2026-06-13-dual-platform-design-system.mdx。
 * 保守规则（只做明确安全的转换，其余留手改）：
 *   - 仅处理 <span> / <p>（文本元素）；<div> 跳过（常是布局容器，需人工判断）。
 *   - className 必须是字符串字面量；动态 className（表达式）跳过。
 *   - 含 flex / grid / inline-flex 的（布局容器）跳过。
 *   - text-[Npx] → variant（typeScale 就近档）；font-bold/semibold/medium/normal → weight。
 *   - 其余 className（颜色 / tracking / 排版）原样保留（Text 不写 letterSpacing inline，
 *     tracking-* 生效）。<p> 补 "block"（display:block 与 p 等价）。
 *   - 自动注入 `import { Text } from "<相对路径>/Text"`。
 *
 * 用法：node scripts/codemods/text-primitive-migrate.mjs <file...>
 * （precise AST 定位 + 字符串编辑，不 re-generate，保留原格式。）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { relative, dirname } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";

const traverse = _traverse.default ?? _traverse;
const TEXT_DIR = "packages/ui-web/src/primitives";
// --from=<spec>：app（frontend/apps-web）从 @pin-ai/ui-web 裸引 Text；
// 不传则用到 ui-web primitives 的相对路径（ui-web 包内部）。
const FROM_IDX = process.argv.findIndex((a) => a.startsWith("--from="));
const FROM_SPEC = FROM_IDX >= 0 ? process.argv[FROM_IDX].slice(7) : null;

function variantFor(px) {
  if (px <= 10) return "micro";
  if (px <= 11) return "caption";
  if (px <= 12) return "label";
  if (px <= 14) return "bodySm";
  if (px <= 16) return "body";
  if (px <= 18) return "subheading";
  if (px <= 21) return "heading";
  if (px <= 26) return "title";
  return "display";
}

const WEIGHT = {
  "font-bold": "bold",
  "font-semibold": "semibold",
  "font-medium": "medium",
  "font-normal": "regular",
};

function migrate(file) {
  const src = readFileSync(file, "utf8");
  let ast;
  try {
    ast = parse(src, { sourceType: "module", plugins: ["typescript", "jsx"] });
  } catch (e) {
    console.error(`  parse-fail ${file}: ${e.message}`);
    return 0;
  }

  const edits = [];
  let count = 0;

  traverse(ast, {
    JSXElement(path) {
      const open = path.node.openingElement;
      if (open.name.type !== "JSXIdentifier") return;
      const tag = open.name.name;
      if (tag !== "span" && tag !== "p" && tag !== "div") return;

      const clsAttr = open.attributes.find(
        (a) =>
          a.type === "JSXAttribute" &&
          a.name.name === "className" &&
          a.value &&
          a.value.type === "StringLiteral",
      );
      if (!clsAttr) return;

      // TextProps 契约只接受 variant/weight/color/numberOfLines/className/children
      // （双端契约不透传 web 的 style / aria-* / onClick 等）。带额外属性的元素跳过，
      // 留手改 —— 仅放行 className 与 React key。
      const hasExtraAttr = open.attributes.some(
        (a) =>
          !(
            a.type === "JSXAttribute" &&
            (a.name.name === "className" || a.name.name === "key")
          ),
      );
      if (hasExtraAttr) return;

      // div 仅处理「单一纯文本子」（无子元素、表达式不含 JSX），避免把布局容器
      // 误转成 Text(span)——span 包 block 子是无效 HTML。div/p 子复杂的留手改。
      if (tag === "div") {
        const sig = path.node.children.filter(
          (c) => !(c.type === "JSXText" && !c.value.trim()),
        );
        if (sig.length !== 1) return;
        if (sig[0].type === "JSXElement" || sig[0].type === "JSXFragment") return;
        if (
          sig[0].type === "JSXExpressionContainer" &&
          src.slice(sig[0].start, sig[0].end).includes("<")
        )
          return;
      }

      const cls = clsAttr.value.value;
      const m = cls.match(/text-\[(\d+(?:\.\d+)?)px\]/);
      if (!m) return;
      if (/\bflex\b|\bgrid\b|\binline-flex\b/.test(cls)) return;

      const variant = variantFor(parseFloat(m[1]));
      let nc = cls.replace(/text-\[[\d.]+px\]/, "").replace(/\s+/g, " ").trim();
      let weight = null;
      for (const [w, n] of Object.entries(WEIGHT)) {
        if (new RegExp(`\\b${w}\\b`).test(nc)) {
          weight = n;
          nc = nc.replace(new RegExp(`\\b${w}\\b`), "").replace(/\s+/g, " ").trim();
          break;
        }
      }
      if ((tag === "p" || tag === "div") && !/\bblock\b/.test(nc)) nc = `block ${nc}`.trim();

      let ins = ` variant="${variant}"`;
      if (weight) ins += ` weight="${weight}"`;

      edits.push({ s: open.name.start, e: open.name.end, t: "Text" });
      edits.push({ s: open.name.end, e: open.name.end, t: ins });
      edits.push({ s: clsAttr.value.start + 1, e: clsAttr.value.end - 1, t: nc });
      if (path.node.closingElement) {
        edits.push({
          s: path.node.closingElement.name.start,
          e: path.node.closingElement.name.end,
          t: "Text",
        });
      }
      count++;
    },
  });

  if (!count) return 0;

  // import 注入（用 AST end 精确定位，避免插进多行 import 中间）。
  if (FROM_SPEC) {
    // app 模式：合并进现有 `import {…} from "@pin-ai/ui-web"`，否则新增一行。
    const existing = ast.program.body.find(
      (n) =>
        n.type === "ImportDeclaration" &&
        n.source.value === FROM_SPEC &&
        n.specifiers.some((s) => s.type === "ImportSpecifier"),
    );
    const hasText =
      existing &&
      existing.specifiers.some((s) => s.type === "ImportSpecifier" && s.imported.name === "Text");
    if (!hasText) {
      if (existing) {
        const named = existing.specifiers.filter((s) => s.type === "ImportSpecifier");
        const last = named[named.length - 1];
        edits.push({ s: last.end, e: last.end, t: ", Text" });
      } else {
        const imports = ast.program.body.filter((n) => n.type === "ImportDeclaration");
        const lastImp = imports[imports.length - 1];
        if (lastImp) edits.push({ s: lastImp.end, e: lastImp.end, t: `\nimport { Text } from "${FROM_SPEC}";` });
      }
    }
  } else if (!/primitives\/Text["']/.test(src)) {
    const imports = ast.program.body.filter((n) => n.type === "ImportDeclaration");
    const lastImp = imports[imports.length - 1];
    if (lastImp) {
      let rel = relative(dirname(file), TEXT_DIR).replace(/\\/g, "/");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      edits.push({ s: lastImp.end, e: lastImp.end, t: `\nimport { Text } from "${rel}/Text";` });
    }
  }

  edits.sort((a, b) => b.s - a.s);
  let out = src;
  for (const ed of edits) out = out.slice(0, ed.s) + ed.t + out.slice(ed.e);

  writeFileSync(file, out);
  return count;
}

const files = process.argv.slice(2).filter((a) => !a.startsWith("--from="));
let total = 0;
for (const f of files) {
  const c = migrate(f);
  if (c) console.log(`  ${c}\t${f}`);
  total += c;
}
console.log(`migrated ${total} 处, ${files.length} 个文件`);
