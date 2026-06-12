/**
 * Assistant 正文的 markdown 渲染（web 端 ReactMarkdown 的 RN 对应物）。
 * 流式性能正解 = block-memo（Vercel streamdown 同构策略）：按空行切块
 * （fence-aware，代码块内空行不切），完成块 memo 后永不重 parse，
 * 只有最后一个未闭合块每 token 重渲——替代「每 token 重 parse 整条
 * 消息」的 O(N) 退化。代价：跨块的 link reference 定义不解析（LLM
 * 输出几乎全用 inline link，可接受，web streamdown 同样取舍）。
 * 样式贴品牌（#1a1a1a 正文 / 代码块浅底圆角 / 链接蓝 / Geist chat 面）。
 */
import { memo } from "react";
import { StyleSheet } from "react-native";
import Markdown from "react-native-markdown-display";

/** 按块切分：空行为界，``` / ~~~ fence 内不切。 */
function splitBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    const joined = cur.join("\n");
    if (joined.trim()) blocks.push(joined);
    cur = [];
  };
  for (const line of lines) {
    if (/^(```|~~~)/.test(line.trimStart())) inFence = !inFence;
    cur.push(line);
    if (!inFence && line.trim() === "") flush();
  }
  flush();
  return blocks;
}

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
  // web .font-native：chat 面 Geist。expo-google-fonts 按字重独立成字体名，
  // 标题/加粗直接指 SemiBold 实例（Geist_700 未打包，600 与 web 视觉等级一致）。
  body: { color: "#1a1a1a", fontSize: 16, lineHeight: 23, fontFamily: "Geist_400Regular" },
  heading1: { fontSize: 22, fontFamily: "Geist_600SemiBold", marginTop: 12, marginBottom: 4 },
  heading2: { fontSize: 19, fontFamily: "Geist_600SemiBold", marginTop: 10, marginBottom: 4 },
  heading3: { fontSize: 17, fontFamily: "Geist_600SemiBold", marginTop: 8, marginBottom: 2 },
  strong: { fontFamily: "Geist_600SemiBold" },
  link: { color: "#2563eb" },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginVertical: 2 },
  code_inline: {
    backgroundColor: "#f4f4f5",
    borderRadius: 4,
    paddingHorizontal: 4,
    fontFamily: "Menlo",
    fontSize: 14,
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
