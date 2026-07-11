import { useEffect, useState } from "react";

/**
 * 匹配一条 CSS media query 并随视口变化更新。SSR / 测试（无 window 或
 * matchMedia）下回退 false。
 *
 * 用途之一：响应式容器切换——宽屏用居中 popup、窄屏用底部 Drawer
 * （shadcn 社区的 Drawer+Dialog 标准做法）。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange(); // 同步一次：query 变化或挂载时立刻对齐当前状态
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
