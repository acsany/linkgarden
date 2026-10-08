import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { faLeaf } from '@fortawesome/free-solid-svg-icons';

// Development-only regeneration; committed PNGs require no image tooling at build time.
mkdirSync('public/icons', { recursive: true });
const [width, height, , , path] = faLeaf.icon;
const glyph = Array.isArray(path) ? path.join(' ') : path;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#6855d9"/><svg x="116" y="116" width="280" height="280" viewBox="0 0 ${width} ${height}"><path fill="white" d="${glyph}"/></svg></svg>`;
writeFileSync('public/icons/favicon.svg', svg);
const browser = await chromium.launch();
try {
  for (const [file, size] of [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['maskable-512.png', 512],
    ['apple-touch-icon.png', 180],
  ]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>body{margin:0}svg{width:100vw;height:100vh;display:block}</style>${svg}`,
    );
    await page.screenshot({ path: `public/icons/${file}` });
    await page.close();
  }
} finally {
  await browser.close();
}
