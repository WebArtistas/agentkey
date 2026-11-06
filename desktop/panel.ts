import type { Rectangle } from 'electron';

/** Screen coordinates are device-independent and may be negative on secondary displays. */
export function panelBounds(anchor: Rectangle, workArea: Rectangle): Rectangle {
  const padding = Math.min(8, Math.floor(Math.min(workArea.width, workArea.height) / 4));
  const width = Math.min(420, workArea.width - padding * 2);
  const height = Math.min(640, workArea.height - padding * 2);
  const clamp = (value: number, low: number, high: number) =>
    Math.round(Math.max(low, Math.min(value, high)));
  const below = anchor.y + anchor.height + padding;
  const preferredY =
    below + height <= workArea.y + workArea.height - padding ? below : anchor.y - height - padding;
  return {
    x: clamp(
      anchor.x + anchor.width / 2 - width / 2,
      workArea.x + padding,
      workArea.x + workArea.width - width - padding,
    ),
    y: clamp(preferredY, workArea.y + padding, workArea.y + workArea.height - height - padding),
    width,
    height,
  };
}
