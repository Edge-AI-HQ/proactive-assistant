/**
 * Assistant 正文的 markdown 渲染（web 端 ReactMarkdown 的 RN 对应物）。
 * 流式性能正解 = block-memo（Vercel streamdown 同构策略）：按空行切块
 * （fence-aware，代码块内空行不切），完成块 memo 后永不重 parse，
 * 只有最后一个未闭合块每 token 重渲——替代「每 token 重 parse 整条
 * 消息」的 O(N) 退化。代价：跨块的 link reference 定义不解析（LLM
 * 输出几乎全用 inline link，可接受，web streamdown 同样取舍）。
 * 样式贴品牌（#1a1a1a 正文 / 代码块浅底圆角 / 链接蓝）。
 */
import { memo } from "react";
import { StyleSheet } from "react-native";
import Markdown from "react-native-markdown-display";
import { splitBlocks } from "@pin-ai/core";

/** memo 边界：text 不变（= 已完成的块）跳过整棵 parse + render。 */
const Block = memo(function Block({ text }: { text: string }) {
  return <Markdown style={markdownStyles}>{text}</Markdown>;
});

export default function MarkdownText({ text }: { text: string }) {
  const blocks = splitBlocks(text);
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} text={b} />
      ))}
    </>
  );
}

const markdownStyles = StyleSheet.create({
  // Message content must keep the iOS system emoji fallback. Custom RN fonts
  // render emoji as missing-glyph boxes in streamed assistant replies.
  // web assistant 正文 = MarkdownContent `p`/`li` text-bodySm（@pin-ai/design
  // bodySm = 13px）leading-relaxed（≈1.625 → lineHeight 21）。标题对齐 web
  // h1 text-subheading(17) / h2 text-body(15) / h3 text-bodySm(13)。
  body: { color: "#1a1a1a", fontSize: 13, lineHeight: 21 },
  heading1: { fontSize: 17, fontWeight: "600", marginTop: 14, marginBottom: 6 },
  heading2: { fontSize: 15, fontWeight: "600", marginTop: 12, marginBottom: 6 },
  heading3: { fontSize: 13, fontWeight: "600", marginTop: 10, marginBottom: 4 },
  strong: { fontWeight: "600" },
  link: { color: "#2563eb" },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginVertical: 2 },
  // web 行内代码 = bg-foreground/[0.06]（半透墨，透出 aurora）+ text-foreground/85
  // + rounded-md(6) + px-1.5 py-0.5 + text-label(12) + font-mono。（web 的极淡
  // 边框 foreground/[0.05] 在 RN 行内 Text 上会画出折行小框，省去。）
  code_inline: {
    backgroundColor: "rgba(29,33,48,0.06)",
    color: "rgba(29,33,48,0.85)",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontFamily: "Menlo",
    fontSize: 12,
  },
  code_block: {
    backgroundColor: "#f4f4f5",
    borderRadius: 10,
    padding: 12,
    fontFamily: "Menlo",
    fontSize: 13,
    borderWidth: 0,
  },
  fence: {
    backgroundColor: "#f4f4f5",
    borderRadius: 10,
    padding: 12,
    fontFamily: "Menlo",
    fontSize: 13,
    borderWidth: 0,
  },
  blockquote: {
    backgroundColor: "transparent",
    borderLeftWidth: 3,
    borderLeftColor: "#d4d4d8",
    paddingLeft: 10,
    marginLeft: 0,
  },
  table: { borderWidth: 1, borderColor: "#e4e4e7", borderRadius: 6 },
  th: { padding: 6, fontWeight: "600" },
  td: { padding: 6 },
  hr: { backgroundColor: "#e4e4e7", marginVertical: 10 },
});
