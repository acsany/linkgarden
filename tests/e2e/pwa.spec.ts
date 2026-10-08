import { test, expect, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your pages' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
}
// Visits without the admin cookie, which would keep them from being counted, while the
// installed service worker stays in place.
async function asVisitor(page: Page, visit: () => Promise<void>) {
  const cookies = await page.context().cookies();
  await page.context().clearCookies();
  try {
    await visit();
  } finally {
    await page.context().addCookies(cookies);
  }
}
async function admin(page: Page, path: string, payload: object, method = 'POST') {
  return page.evaluate(
    async ({ path, payload, method }) => {
      const session = await (await fetch('/api/auth/session')).json();
      const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
      return response.json();
    },
    { path, payload, method },
  );
}

test('built PWA manifest, icons, native clipboard, and browser installation control', async ({
  page,
  context,
}) => {
  await signIn(page);
  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.headers()['content-type']).toContain('manifest+json');
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    id: '/admin',
    start_url: '/admin',
    scope: '/',
    display: 'standalone',
  });
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/png');
    const buffer = await response.body();
    expect(buffer.subarray(1, 4).toString()).toBe('PNG');
    const size = Number(icon.sizes.split('x')[0]);
    expect(buffer.readUInt32BE(16)).toBe(size);
    expect(buffer.readUInt32BE(20)).toBe(size);
  }
  const worker = await page.request.get('/sw.js');
  expect(worker.headers()['content-type']).toContain('javascript');
  expect(worker.headers()['cache-control']).toBe('no-cache');
  expect(worker.headers()['service-worker-allowed']).toBe('/');
  expect(await worker.text()).not.toContain('__PRECACHE__');
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt');
    Object.assign(event, {
      prompt: async () => {
        (window as any).installPrompted = true;
      },
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    window.dispatchEvent(event);
  });
  await page.getByRole('button', { name: 'Install Linkgarden' }).click();
  expect(await page.evaluate(() => (window as any).installPrompted)).toBe(true);
  const site = await admin(page, '/api/admin/sites', {
    slug: 'CopyPwa',
    title: 'PWA copy test',
    links: [{ url: 'https://example.com' }],
  });
  await page.reload();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page
    .locator('tr')
    .filter({ hasText: site.title })
    .getByRole('button', { name: 'Copy short URL' })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'http://localhost:3200/CopyPwa',
  );
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(page.getByRole('button', { name: 'Install Linkgarden' })).toHaveCount(0);
});

test('offline PWA retains only static assets and reconnects without caching private data', async ({
  page,
  context,
}) => {
  await signIn(page);
  const site = await admin(page, '/api/admin/sites', {
    slug: 'OfflineSafe',
    title: 'Private fixture',
    note: 'Secret note never in a cache',
    links: [{ url: 'https://example.com' }],
  });
  await admin(page, '/api/admin/tokens', {
    name: 'PWA cache safety fixture',
    scope: 'read',
    days: 7,
  });
  await page.goto('/admin/sites/' + site.id + '/edit');
  await expect(page.getByLabel('Private note')).toHaveValue('Secret note never in a cache');
  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: "You're offline" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  // The existing form stays in memory while open; it is never written to offline storage.
  await page.getByLabel('Private note').fill('Unsaved work in memory');
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  await expect(page.getByLabel('Private note')).toHaveValue('Unsaved work in memory');
  await page.getByLabel('Private note').fill('Secret note never in a cache');
  await context.setOffline(true);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Secret note never in a cache');
  expect(
    await page.evaluate(async () => {
      try {
        await fetch('/api/admin/sites');
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  expect(
    await page.evaluate(async (id) => {
      try {
        await fetch('/r/' + id);
        return false;
      } catch {
        return true;
      }
    }, site.links[0].id),
  ).toBe(true);
  const entries = await page.evaluate(async () => {
    const result: { path: string; text: string }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = (await cache.match(request))!;
        result.push({
          path: new URL(request.url).pathname,
          text: (response.headers.get('content-type') || '').includes('image')
            ? ''
            : await response.text(),
        });
      }
    }
    return result;
  });
  expect(entries.some((entry) => entry.path === '/offline.html')).toBe(true);
  expect(
    entries.some((entry) => entry.path.startsWith('/assets/') && entry.path.endsWith('.js')),
  ).toBe(true);
  for (const entry of entries) {
    expect(entry.path).toMatch(
      /^(?:\/assets\/[^/]+\.(?:js|css|woff2?)|\/icons\/[^/]+\.(?:png|svg)|\/manifest\.webmanifest|\/offline\.html)$/,
    );
    expect(entry.text).not.toContain('Secret note never in a cache');
    expect(entry.text).not.toContain('Unsaved work in memory');
  }
  await context.setOffline(false);
  await page.getByRole('link', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Your pages' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('service worker preserves visit tracking and immediate URL/status changes', async ({
  page,
}) => {
  await signIn(page);
  const site = await admin(page, '/api/admin/sites', {
    slug: 'LivePwa',
    title: 'Live collection',
    links: [{ url: 'https://example.com' }],
  });
  await asVisitor(page, async () => {
    await page.goto('/LivePwa');
    await expect(page.getByRole('heading', { name: 'Live collection' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Live collection' })).toBeVisible();
  });
  await page.goto('/admin/sites/' + site.id + '/analytics');
  await expect(page.locator('.stat-value').first()).toHaveText('2');
  await admin(page, '/api/admin/sites/' + site.id + '/status', { status: 'inactive' }, 'PATCH');
  // The admin still sees the inactive page, flagged; visitors get a 404.
  await page.goto('/LivePwa');
  await expect(page.getByRole('status')).toContainText('This page is inactive');
  await asVisitor(page, async () => {
    expect((await page.goto('/LivePwa'))!.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page unavailable' })).toBeVisible();
  });
  await admin(
    page,
    '/api/admin/sites/' + site.id,
    { ...site, slug: 'LivePwaNext', status: 'active' },
    'PUT',
  );
  await asVisitor(page, async () => {
    expect((await page.goto('/LivePwa'))!.status()).toBe(404);
    await page.goto('/LivePwaNext');
    await expect(page.getByRole('heading', { name: 'Live collection' })).toBeVisible();
  });
  const forward = await admin(page, '/api/admin/sites', {
    slug: 'ForwardPwa',
    title: 'Live forward',
    mode: 'redirect',
    links: [
      {
        url: 'http://localhost:3200/icons/favicon.svg',
        title: 'Local test destination',
        imageUrl: 'https://example.com/icon.png',
      },
    ],
  });
  await asVisitor(page, async () => {
    for (let i = 0; i < 2; i++) {
      await page.goto('/ForwardPwa');
      await expect(page).toHaveURL('http://localhost:3200/icons/favicon.svg');
    }
  });
  await page.goto('/admin/sites/' + forward.id + '/analytics');
  await expect(page.locator('.stat-value').first()).toHaveText('2');
  await expect(page.locator('.stat-value').nth(1)).toHaveText('2');
  await admin(page, '/api/admin/sites/' + forward.id + '/status', { status: 'inactive' }, 'PATCH');
  await asVisitor(page, async () => {
    expect((await page.goto('/ForwardPwa'))!.status()).toBe(404);
  });
});
test('a real worker update waits for an explicit refresh and keeps open edits intact', async ({
  page,
}) => {
  await signIn(page);
  const site = await admin(page, '/api/admin/sites', {
    slug: 'UpdatePwa',
    title: 'Before update',
    links: [
      { url: 'https://example.com', title: 'Example', imageUrl: 'https://example.com/icon.png' },
    ],
  });
  await page.goto('/admin/sites/' + site.id + '/edit');
  await page.getByLabel('Title', { exact: true }).fill('Saved before refreshing');
  await page.request.post('/__test/update-worker');
  await page.evaluate(async () => (await navigator.serviceWorker.ready).update());
  await expect(page.getByRole('button', { name: 'Refresh app' })).toBeVisible();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Saved before refreshing');
  await expect(page.locator('.update-banner')).toContainText('Save your changes');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your pages' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh app' }).click();
  await expect(page.getByRole('button', { name: 'Refresh app' })).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Saved before refreshing', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await caches.keys()).filter((name) => name.startsWith('linkgarden-static-')).length,
      ),
    )
    .toBe(1);
});
