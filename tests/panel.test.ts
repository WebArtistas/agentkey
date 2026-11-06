import assert from 'node:assert/strict';
import { test } from 'node:test';
import { panelBounds } from '../desktop/panel';

test('quick panel stays inside top, bottom, secondary and small display work areas', () => {
  for (const workArea of [
    { x: 0, y: 24, width: 1920, height: 1056 },
    { x: -1280, y: -200, width: 1280, height: 720 },
    { x: 0, y: 0, width: 320, height: 480 },
  ]) {
    for (const anchor of [
      { x: workArea.x, y: workArea.y, width: 24, height: 24 },
      {
        x: workArea.x + workArea.width - 24,
        y: workArea.y + workArea.height,
        width: 24,
        height: 24,
      },
      { x: workArea.x + 50, y: workArea.y + 50, width: 0, height: 0 },
    ]) {
      const result = panelBounds(anchor, workArea);
      assert.ok(result.x >= workArea.x && result.y >= workArea.y);
      assert.ok(result.x + result.width <= workArea.x + workArea.width);
      assert.ok(result.y + result.height <= workArea.y + workArea.height);
      assert.ok(result.width <= 420 && result.height <= 640);
    }
  }
});
