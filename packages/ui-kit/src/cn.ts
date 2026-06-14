import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 className：clsx 做条件拼接，tailwind-merge 消解冲突（后者覆盖前者）。
 * web 与 RN（NativeWind）通用——双端共享的唯一 className 工具。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
