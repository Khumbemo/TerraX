import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map(m => [m[1], m[2]]));
}

/** WCAG 2.x relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('text colours meet WCAG AA contrast in both themes', () => {
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-9);
  const dark = tokens(':root');
  const light = { ...dark, ...tokens(":root[data-theme='light']") };
  const galaxy = { ...dark, ...tokens(":root[data-theme='galaxy']") };
  for (const [name, t] of [['dark', dark], ['light', light], ['galaxy', galaxy]] as const) {
    for (const bg of ['bg', 'panel', 'panel-2']) {
      for (const fg of ['text', 'muted', 'dim', 'accent']) {
        const c = contrast(t[fg], t[bg]);
        assert.ok(c >= 4.5, `${name}: --${fg} ${t[fg]} on --${bg} ${t[bg]} is ${c.toFixed(2)}:1`);
      }
    }
    // Primary buttons: ink on accent.
    assert.ok(contrast(t['accent-ink'], t.accent) >= 4.5, `${name}: button text ${contrast(t['accent-ink'], t.accent).toFixed(2)}:1`);
  }
});
