import { describe, expect, it } from 'vitest';
import { fetchMetadata, isPublicAddress, publicAddress, safeFetch } from '../server/metadata.js';
describe('preview fetch SSRF boundaries', () => {
  it.each([
    '127.0.0.1',
    '10.2.3.4',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('blocks non-public address %s', (address) => expect(isPublicAddress(address)).toBe(false));
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('permits public address %s', (address) =>
    expect(isPublicAddress(address)).toBe(true),
  );
  it.each([
    'http://localhost',
    'http://127.1',
    'http://2130706433',
    'http://[::1]',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1',
    'https://example.com:8443',
    'http://localhost.local',
  ])('rejects private or nonstandard destination %s', async (url) => {
    await expect(publicAddress(url)).rejects.toThrow();
    await expect(safeFetch(url)).rejects.toThrow();
  });
  it('returns a manual-preview fallback without accessing the local service', async () => {
    const preview = await fetchMetadata('http://localhost/secret');
    expect(preview.warning).toContain('Private network');
    expect(preview.imageUrl).toBe('');
  });
});
