import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { thumbnail, previewKey } from '../server/previews.js';

describe('stored previews', () => {
  it('canonicalizes tracking parameters and Real Python URLs', () => {
    expect(previewKey('https://www.realpython.com/python-basics/?utm_source=x#top')).toBe(
      'https://realpython.com/python-basics/',
    );
    expect(previewKey('https://example.com/a?b=2&a=1')).toBe('https://example.com/a?a=1&b=2');
  });

  it('normalizes accepted images into bounded WebP thumbnails', async () => {
    const input = await sharp({
      create: { width: 32, height: 16, channels: 3, background: { r: 220, g: 40, b: 80 } },
    })
      .png()
      .toBuffer();
    const output = await thumbnail(input);
    const info = await sharp(output).metadata();
    expect(info.format).toBe('webp');
    expect(info.width).toBe(32);
    expect(info.height).toBe(16);
  });

  it('rejects non-image bytes', async () => {
    await expect(thumbnail(Buffer.from('not an image'))).rejects.toThrow('valid JPEG');
  });
});
