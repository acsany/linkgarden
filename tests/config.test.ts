import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../server/config.js';
afterEach(() => vi.unstubAllEnvs());
describe('runtime configuration', () => {
  it('defaults to loopback and embedded PostgreSQL locally', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HOST', '');
    vi.stubEnv('APP_ORIGIN', '');
    vi.stubEnv('RENDER_EXTERNAL_URL', '');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('PORT', '3000');
    const c = getConfig();
    expect(c.host).toBe('127.0.0.1');
    expect(c.origin).toBe('http://localhost:3000');
  });
  it('requires durable PostgreSQL and HTTPS in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ORIGIN', 'http://localhost:3000');
    vi.stubEnv('DATABASE_URL', '');
    expect(() => getConfig()).toThrow('Production requires');
    vi.stubEnv('APP_ORIGIN', 'https://example.com');
    expect(() => getConfig()).toThrow('Production requires');
    vi.stubEnv('DATABASE_URL', 'postgresql://example');
    vi.stubEnv('FILES_DIR', '');
    expect(() => getConfig()).toThrow('FILES_DIR');
    vi.stubEnv('FILES_DIR', '/var/data/files');
    expect(getConfig().origin).toBe('https://example.com');
    expect(getConfig().filesDir).toBe('/var/data/files');
  });
  it('rejects origins with paths or credentials', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_ORIGIN', 'https://example.com/path');
    expect(() => getConfig()).toThrow('plain origin');
    vi.stubEnv('APP_ORIGIN', 'https://user:pass@example.com');
    expect(() => getConfig()).toThrow('plain origin');
  });
});
