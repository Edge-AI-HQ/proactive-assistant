const TOP_DRAG_REGION_HEIGHT_PX = 38;
const TOP_RIGHT_SAFE_ZONE_PX = 64;

export function buildTopDragRegionCss(): string {
  return `
      body::before {
        content: '';
        position: fixed;
        top: 0;
        left: 0;
        right: ${TOP_RIGHT_SAFE_ZONE_PX}px;
        height: ${TOP_DRAG_REGION_HEIGHT_PX}px;
        -webkit-app-region: drag;
        z-index: 9999;
        pointer-events: auto;
      }
      button, a, input, [role="button"] {
        -webkit-app-region: no-drag;
      }
    `;
}

