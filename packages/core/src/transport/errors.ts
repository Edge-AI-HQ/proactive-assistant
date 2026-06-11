/** 解析后端错误响应为可展示消息。
 * 新 shape `{ error: { code, message } }`（Stripe / Google Cloud convention）
 * 优先，回退 legacy `{ error: "string" }`，最后原始文本。 */
export async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${res.status}`;

    try {
      const data = JSON.parse(text) as { error?: unknown };
      if (data?.error && typeof data.error === "object" && data.error !== null) {
        const obj = data.error as { code?: unknown; message?: unknown };
        if (typeof obj.message === "string" && obj.message.trim()) {
          return `${res.status} ${obj.message}`;
        }
      }
      if (typeof data?.error === "string" && data.error.trim()) {
        return `${res.status} ${data.error}`;
      }
    } catch {
      // Fall back to the raw response text when the body is not JSON.
    }

    return `${res.status} ${text}`;
  } catch {
    return `${res.status}`;
  }
}
