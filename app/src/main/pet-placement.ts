import { clampBounds, snapBounds, type Rect } from './drag';

// The artwork's leftmost opaque pixel is at 62/512 across all frames.
// Only let 9% transparent padding leave the screen (also allows breathing).
// Keep the right/top/bottom boundaries unchanged, and never resize the pet.
function petArea(bounds: Rect, area: Rect): Rect {
  const allowance = Math.max(0, Math.floor(bounds.width * .09) - 3);
  return { ...area, x: area.x - allowance, width: area.width + allowance };
}
export const clampPetBounds = (bounds: Rect, area: Rect): Rect => clampBounds(bounds, petArea(bounds, area));
export const snapPetBounds = (bounds: Rect, area: Rect): Rect => snapBounds(bounds, petArea(bounds, area));
