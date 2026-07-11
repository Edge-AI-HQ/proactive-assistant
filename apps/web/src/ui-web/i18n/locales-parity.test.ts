import { describe, expect, test } from "vitest";

// eager: 测试时同步拿到所有翻译文件
const modules = import.meta.glob<{ default: Record<string, unknown> }>(
  "../../../../../packages/ui-kit/src/locales/*/*.json",
  { eager: true },
);

// 复数后缀是语言相关的(zh/ja/ko 只有 _other,en 有 _one/_other),
// 对齐比较的是"逻辑 key"(去掉复数后缀)。
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function flatten(obj: Record<string, unknown>, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else if (v && typeof v === "object") {
      for (const [ck, cv] of flatten(v as Record<string, unknown>, key)) out.set(ck, cv);
    }
  }
  return out;
}

function logicalKeys(flat: Map<string, string>): Set<string> {
  return new Set([...flat.keys()].map((k) => k.replace(PLURAL_SUFFIX, "")));
}

function placeholders(value: string): string {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(",");
}

// 按语言分组:{ en: { common: flatMap, ... }, ja: {...} }
const byLang = new Map<string, Map<string, Map<string, string>>>();
for (const [path, mod] of Object.entries(modules)) {
  const m = path.match(/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!m) continue;
  const [, lang, ns] = m;
  if (!byLang.has(lang)) byLang.set(lang, new Map());
  byLang.get(lang)!.set(ns, flatten(mod.default));
}

const en = byLang.get("en");
if (!en) throw new Error("locales/en 不存在——en 是翻译基准,必须存在");

// 8 语言硬编码:少一个语言目录、少一个 key、占位符不齐,CI 直接红。
const EXPECTED_LANGUAGES = ["en", "zh-Hans", "ja", "ko", "es", "fr", "de", "pt"];

describe("locales parity(防翻译烂尾门禁)", () => {
  test("所有预期语言的翻译目录都存在", () => {
    for (const lang of EXPECTED_LANGUAGES) {
      expect(byLang.has(lang), `缺语言目录 locales/${lang}`).toBe(true);
    }
  });

  for (const lang of EXPECTED_LANGUAGES.filter((l) => l !== "en")) {
    test(`${lang}: namespace 与逻辑 key 和 en 完全对齐`, () => {
      const target = byLang.get(lang)!;
      expect([...target.keys()].sort()).toEqual([...en.keys()].sort());
      for (const [ns, enFlat] of en) {
        const tgt = logicalKeys(target.get(ns)!);
        const src = logicalKeys(enFlat);
        expect([...tgt].sort(), `${lang}/${ns} 的 key 集合`).toEqual([...src].sort());
      }
    });

    test(`${lang}: 每条译文的 {{占位符}} 集合和 en 一致`, () => {
      const target = byLang.get(lang)!;
      for (const [ns, enFlat] of en) {
        const tgtFlat = target.get(ns)!;
        for (const [key, enVal] of enFlat) {
          const logical = key.replace(PLURAL_SUFFIX, "");
          // 用同逻辑 key 下任一形态比较(复数形态数量语言相关)
          const tgtVal = [...tgtFlat.entries()].find(
            ([k]) => k.replace(PLURAL_SUFFIX, "") === logical,
          )?.[1];
          if (tgtVal === undefined) continue; // key 缺失由上一个测试报
          expect(placeholders(tgtVal), `${lang}/${ns}:${logical} 占位符`).toBe(
            placeholders(enVal),
          );
        }
      }
    });
  }
});
