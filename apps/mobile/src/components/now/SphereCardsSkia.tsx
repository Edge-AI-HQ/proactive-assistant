/**
 * __HEAT_AB__ 混合渲染的 **Skia 背景层**——只画每张卡的「底 + 阴影 + 高光 + 边」,
 * 由 SphereCards 传入的**共享 yaw** 驱动(不自持动画回路)。文字/图标/交互仍是 SphereCards
 * 的原生层叠在本层之上(透明卡片,只做 transform,不重绘 = 凉)。
 *
 * 为什么这样最凉:把「卡片+阴影」用 drawAsImage 烤成一张 4× 高清贴图**一次**,之后每帧
 * 只 <Image> 贴这张已模糊好的图 + transform/opacity(纯纹理 blit,零每帧模糊)。真机验证:
 * 这版几乎不发热(vs 第一版每帧重画模糊阴影反而更热)。
 *
 * 与 SphereCards 严丝合缝对齐:两层用同一 yaw + 同一投影数学 + 同一每卡 point(SphereCards
 * 的首见槽位),cx/cy = 原生 center 容器的 left/top(width/2, height*(CENTER_TOP+SHIFT))。
 */
import { useEffect, useMemo, useState } from "react";
import {
  Box,
  BoxShadow,
  Canvas,
  Group,
  Image,
  drawAsImage,
  rect,
  rrect,
  type SkImage,
} from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

// 布局常量与 SphereCards 同源(由 SphereCards 传 rx/ry/cx/cy,这里只需卡片尺寸)。
const CARD_W = 160;
const CARD_H = 68;

// 贴图 = 卡片 + 四周留白(容纳投影 blur 9 + offset 4)。4× 分辨率烤,放大到 1.25× 仍清晰。
const SPRITE_PAD = 24;
const SPRITE_W = CARD_W + 2 * SPRITE_PAD;
const SPRITE_H = CARD_H + 2 * SPRITE_PAD;
const SPRITE_SCALE = 4;

export interface SkiaBgItem {
  id: string;
  point: { x: number; y: number; z: number };
}

/** 单张卡的背景贴图:一个 Group(transform + opacity 由共享 yaw 驱动)贴一张烤好的
 *  卡片贴图(含底+影+高光+边)。投影数学与 SphereCards 的 Card worklet 逐字同源。 */
function SkiaBgCard({
  point,
  yaw,
  pitch,
  rx,
  ry,
  cx,
  cy,
  sprite,
}: {
  point: { x: number; y: number; z: number };
  yaw: SharedValue<number>;
  pitch: SharedValue<number>;
  rx: number;
  ry: number;
  cx: number;
  cy: number;
  sprite: SkImage;
}) {
  const state = useDerivedValue(() => {
    const yawR = (yaw.value * Math.PI) / 180;
    const pitchR = (pitch.value * Math.PI) / 180;
    const cyr = Math.cos(yawR);
    const syr = Math.sin(yawR);
    const x0 = point.x * cyr + point.z * syr;
    const z0 = -point.x * syr + point.z * cyr;
    const cpr = Math.cos(pitchR);
    const spr = Math.sin(pitchR);
    const y1 = point.y * cpr - z0 * spr;
    const z1 = point.y * spr + z0 * cpr;
    const rDepth = Math.min(rx, ry);
    const px = x0 * rx;
    const py = y1 * ry;
    const pz = z1 * rDepth;
    const depth = (pz + rDepth) / (2 * rDepth);
    return { px, py, pz, depth };
  });
  const transform = useDerivedValue(() => {
    const s = state.value;
    return [
      { translateX: cx + s.px },
      { translateY: cy + s.py },
      { scale: 0.6 + s.depth * 0.65 },
    ];
  });
  const opacity = useDerivedValue(() => 0.32 + state.value.depth * 0.68);
  // 与原生文字层同步的深度排序(原生 Card zIndex = Math.round(1000+z))——否则背景贴图
  // 按数组序画,重叠时后卡白面盖前卡。
  const zIndex = useDerivedValue(() => Math.round(1000 + state.value.pz));

  return (
    <Group transform={transform} opacity={opacity} zIndex={zIndex}>
      <Image
        image={sprite}
        x={-SPRITE_W / 2}
        y={-SPRITE_H / 2}
        width={SPRITE_W}
        height={SPRITE_H}
        fit="fill"
      />
    </Group>
  );
}

export default function SphereCardsSkiaBg({
  renderItems,
  yaw,
  pitch,
  rx,
  ry,
  cx,
  cy,
  width,
  height,
}: {
  /** 每张可见卡 + 它的球面 point(SphereCards 的首见槽位解析后传入,保证与原生层对齐)。 */
  renderItems: SkiaBgItem[];
  yaw: SharedValue<number>;
  pitch: SharedValue<number>;
  rx: number;
  ry: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}) {
  // 一次性把「投影」烤成一张高分辨率贴图(v2:底/边/高光/文字都由原生不透明卡画,
  // Skia 只补浮起阴影这一件事——阴影每帧重栅化才是发热源,烤成贴图后每帧只贴图零模糊)。
  const [sprite, setSprite] = useState<SkImage | null>(null);
  useEffect(() => {
    let alive = true;
    const box = rrect(rect(SPRITE_PAD, SPRITE_PAD, CARD_W, CARD_H), 14, 14);
    // 透明卡形 + 一层 drop 投影 = 只出阴影;卡面本体在原生层不透明地画在贴图之上。
    const element = (
      <Group transform={[{ scale: SPRITE_SCALE }]}>
        <Box box={box} color="rgba(0,0,0,0)">
          <BoxShadow dx={0} dy={4} blur={9} color="rgba(0,0,0,0.18)" />
        </Box>
      </Group>
    );
    void drawAsImage(element, {
      width: SPRITE_W * SPRITE_SCALE,
      height: SPRITE_H * SPRITE_SCALE,
    }).then((img) => {
      if (alive) setSprite(img);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Canvas style={{ position: "absolute", width, height }} pointerEvents="none">
      {sprite
        ? renderItems.map((it) => (
            <SkiaBgCard
              key={it.id}
              point={it.point}
              yaw={yaw}
              pitch={pitch}
              rx={rx}
              ry={ry}
              cx={cx}
              cy={cy}
              sprite={sprite}
            />
          ))
        : null}
    </Canvas>
  );
}
