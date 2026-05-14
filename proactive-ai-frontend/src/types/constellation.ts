/**
 * Constellation 视觉组件消费的卡片类型。
 *
 * `Intent` 是我们 IntentCard 的"展示视图"形态：id 转成 stable number 方便 sphere
 * 组件做 key 比较，`originalId` 保留 string 用来反查真实 IntentCard。映射逻辑在
 * `src/lib/cardAdapter.ts`。
 *
 * `detail.executionPlan` / `detail.impact` / `detail.permissions` 在后端没接的
 * 阶段会留空（[] 或 ""），CardDrawerDetail 根据空值隐藏对应 section。
 */

export type CardStatus = "normal" | "new" | "processing" | "done";

export type CardCategory =
  | "growth"
  | "work"
  | "finance"
  | "health"
  | "learn"
  | "life";

export interface ExecutionStep {
  text: string;
  tool: string;
}

export interface Artifact {
  kind: "email" | "notes" | "message" | "doc";
  app: "gmail" | "slack" | "notion" | "gdocs";
  title: string;
  meta?: string;
  body: string;
}

export interface DetailData {
  scores: { label: string; value: number }[];
  willExecute: string;
  executionPlan: ExecutionStep[];
  dataSources: string[];
  impact: string;
  permissions: string;
  result?: string;
  artifacts?: Artifact[];
}

export interface Intent {
  id: number;
  /** 真实 IntentCard.id，调用方需要反查时用。 */
  originalId: string;
  category: CardCategory;
  tag?: string;
  complexity?: "simple";
  locked?: boolean;
  title: string;
  line1: string;
  line2: string;
  detail?: DetailData;
  status: CardStatus;
  statusTimestamp?: number;
}
