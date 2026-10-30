import { clampBounds, type Rect } from './drag';

export const BUBBLE_WIDTH = 280;
export const BUBBLE_HEIGHT = 126;
export function bubbleBounds(pet: Rect, area: Rect, width = BUBBLE_WIDTH, height = BUBBLE_HEIGHT): Rect {
  width = Math.min(width, area.width); height = Math.min(height, area.height);
  const x = pet.x + (pet.width - width) / 2;
  const y = pet.y - height - 2;
  if (y >= area.y) return clampBounds({ x, y, width, height }, area);
  // At the top edge there is no headroom: use the side with more free space,
  // keeping the whole bubble readable instead of covering the face.
  const rightSpace = area.x + area.width - pet.x - pet.width;
  const leftSpace = pet.x - area.x;
  const sideX = rightSpace >= leftSpace ? pet.x + pet.width + 10 : pet.x - width - 10;
  return clampBounds({ x: sideX, y: pet.y, width, height }, area);
}
export function bubbleDocument(text: string): string {
  const chars = Array.from(text); const visible = chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : text;
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  *{box-sizing:border-box}html,body{margin:0;background:transparent;font-family:'Microsoft YaHei','Segoe UI',sans-serif}
  body{padding:6px;display:flex;align-items:flex-end;justify-content:center;height:${BUBBLE_HEIGHT}px}
  p{margin:0;padding:8px 11px;background:rgba(255,253,249,.8);border:1px solid #e8d9ca99;border-radius:15px;color:#382b24;font-size:14px;font-weight:500;line-height:20px;box-shadow:0 2px 6px #0002;overflow-wrap:anywhere;white-space:pre-wrap;max-height:114px;overflow:hidden;width:100%}
  </style><p role="status" aria-label="${escape(text)}">${escape(visible)}</p></html>`;
}
