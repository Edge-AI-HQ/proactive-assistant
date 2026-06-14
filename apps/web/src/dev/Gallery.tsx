import { useState } from "react";
import { Check } from "lucide-react";
import { Text, Button, Input, Surface } from "@pin-ai/ui-web";

/**
 * 设计系统 Gallery —— dev-only living styleguide / 视觉验证基座。
 *
 * 隔离渲染所有 primitive 的全 variant（不依赖运行时数据），让设计系统能在不进
 * authed 数据屏的前提下被截图核对(S3 验证基建)。仅 import.meta.env.DEV 下挂载
 * （见 App.tsx 路由 /dev/gallery）。后续 S5 新增 primitive 都在此登记。
 */
const TEXT_VARIANTS = [
  "display", "title", "heading", "subheading", "body", "bodySm", "label", "caption", "micro",
] as const;
const TEXT_WEIGHTS = ["regular", "medium", "semibold", "bold"] as const;
const TEXT_COLORS = ["foreground", "muted", "primary"] as const;
const BTN_VARIANTS = ["primary", "secondary", "ghost", "danger"] as const;
const BTN_SIZES = ["sm", "md", "lg"] as const;
const SURFACE_VARIANTS = ["solid", "glass"] as const;
const ELEVATIONS = ["sm", "md", "lg"] as const;
const INPUT_SIZES = ["sm", "md", "lg"] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <Text as="h2" variant="heading" weight="semibold" className="mb-4 border-b border-foreground/10 pb-2">
        {title}
      </Text>
      {children}
    </section>
  );
}

export default function Gallery() {
  const [text, setText] = useState("");

  return (
    <div className="h-full overflow-auto bg-background px-10 py-10">
      <Text as="h1" variant="display" weight="bold" className="mb-1">
        Design System Gallery
      </Text>
      <Text as="p" variant="bodySm" color="muted" className="mb-10">
        @pin-ai/ui-kit 契约 + cva · ui-web web 实现 · dev-only styleguide
      </Text>

      <Section title="Text · typeScale">
        {TEXT_VARIANTS.map((v) => (
          <div key={v} className="flex items-baseline gap-4 py-1">
            <Text as="span" variant="caption" color="muted" className="w-24 shrink-0 tabular-nums">
              {v}
            </Text>
            <Text as="div" variant={v}>
              The quick brown fox · 敏捷的棕色狐狸 · 1234567890
            </Text>
          </div>
        ))}
      </Section>

      <Section title="Text · weight">
        <div className="flex flex-wrap gap-6">
          {TEXT_WEIGHTS.map((w) => (
            <Text key={w} as="div" variant="subheading" weight={w}>
              {w} 字重 Aa
            </Text>
          ))}
        </div>
      </Section>

      <Section title="Text · color">
        <div className="flex flex-wrap gap-6">
          {TEXT_COLORS.map((c) => (
            <Text key={c} as="div" variant="body" color={c}>
              {c}
            </Text>
          ))}
        </div>
      </Section>

      <Section title="Button · variant × size">
        {BTN_VARIANTS.map((variant) => (
          <div key={variant} className="mb-3 flex flex-wrap items-center gap-3">
            {BTN_SIZES.map((size) => (
              <Button key={size} variant={variant} size={size} onPress={() => {}}>
                {variant} {size}
              </Button>
            ))}
            <Button variant={variant} leftIcon={<Check size={14} strokeWidth={2} />} onPress={() => {}}>
              icon
            </Button>
            <Button variant={variant} disabled onPress={() => {}}>
              disabled
            </Button>
          </div>
        ))}
      </Section>

      <Section title="Input · size">
        <div className="flex max-w-md flex-col gap-3">
          {INPUT_SIZES.map((size) => (
            <Input key={size} size={size} value={text} onValueChange={setText} placeholder={`size ${size}`} />
          ))}
          <Input value="" onValueChange={() => {}} placeholder="disabled" disabled />
        </div>
      </Section>

      <Section title="Surface · variant × elevation">
        <div className="flex flex-wrap gap-4">
          {SURFACE_VARIANTS.map((variant) =>
            ELEVATIONS.map((elevation) => (
              <Surface
                key={`${variant}-${elevation}`}
                variant={variant}
                elevation={elevation}
                className="flex h-24 w-44 items-center justify-center rounded-2xl"
              >
                <Text as="span" variant="caption" color="muted">
                  {variant} / {elevation}
                </Text>
              </Surface>
            )),
          )}
        </div>
      </Section>
    </div>
  );
}
