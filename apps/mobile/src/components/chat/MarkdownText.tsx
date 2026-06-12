/**
 * Assistant 正文的 markdown 渲染（web 端 ReactMarkdown 的 RN 对应物）。
 * 样式贴品牌（#1a1a1a 正文 / 代码块浅底圆角 / 链接蓝）。
 */
import { StyleSheet } from "react-native";
import Markdown from "react-native-markdown-display";

export default function MarkdownText({ text }: { text: string }) {
  return <Markdown style={markdownStyles}>{text}</Markdown>;
}

const markdownStyles = StyleSheet.create({
  body: { color: "#1a1a1a", fontSize: 16, lineHeight: 23 },
  heading1: { fontSize: 22, fontWeight: "700", marginTop: 12, marginBottom: 4 },
  heading2: { fontSize: 19, fontWeight: "700", marginTop: 10, marginBottom: 4 },
  heading3: { fontSize: 17, fontWeight: "600", marginTop: 8, marginBottom: 2 },
  strong: { fontWeight: "700" },
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
