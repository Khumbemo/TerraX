// Draws the TerraX logo files from src/components/LogoMark.tsx: public/logo.svg and the app icons
// (public/icons/*.png, rendered with Playwright's Chromium). Run: npx tsx scripts/make-logo.tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from '@playwright/test';
import LogoMark from '../src/components/LogoMark';
import { globePaths, landFrom } from '../src/lib/globe';

const root = new URL('..', import.meta.url).pathname;
const land = landFrom(JSON.parse(readFileSync(`${root}node_modules/world-atlas/land-110m.json`, 'utf8')));
const paths = globePaths(land);
const svg = (tile: 'rounded' | 'full' | 'none') => renderToStaticMarkup(createElement(LogoMark, { ...paths, tile, title: 'TerraX' }));

writeFileSync(`${root}public/logo.svg`, svg('none'));

const icons: [string, number, 'rounded' | 'full'][] = [
  ['icon-192.png', 192, 'rounded'],
  ['icon-512.png', 512, 'rounded'],
  ['icon-maskable-512.png', 512, 'full'], // the platform crops it: mark inside the 80 % safe zone
  ['apple-touch-icon.png', 180, 'full'], // iOS rounds the corners itself
];
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [name, size, tile] of icons) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent">${svg(tile).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await page.screenshot({ path: `${root}public/icons/${name}`, omitBackground: true });
}
await browser.close();
console.log('logo.svg and', icons.length, 'icons written');
