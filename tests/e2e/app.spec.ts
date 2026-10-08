import { test, expect } from '@playwright/test';
import { themeIds } from '../../shared/themes';
test('admin, public collection, analytics, duplication, archive, and browser agent lifecycle', async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    const tools = new Map<string, any>();
    Object.defineProperty(document, 'modelContext', {
      value: {
        registerTool: (tool: any, options: { signal: AbortSignal }) => {
          tools.set(tool.name, tool);
          options.signal.addEventListener('abort', () => tools.delete(tool.name));
          return Promise.resolve();
        },
        getTools: () => Array.from(tools.values()),
      },
    });
    (window as any).testTools = tools;
  });
  await page.route('**/api/admin/metadata', (r) =>
    r.fulfill({
      json: {
        title: 'Vue.js',
        description: 'The progressive JavaScript framework',
        imageUrl: 'https://example.com/vue.jpg',
        warning: '',
      },
    }),
  );
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your pages' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Array.from((window as any).testTools.keys()).length))
    .toBe(19);
  await page.getByRole('link', { name: 'New page', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Developer links');
  await page.getByLabel('Short URL slug').fill('Vue42');
  await page
    .getByLabel('Description', { exact: true })
    .first()
    .fill('Useful links for building with Vue.');
  await page.getByLabel('Destination URL').fill('https://vuejs.org');
  await page.getByLabel('Link title').click();
  await expect(page.getByLabel('Link title')).toHaveValue('Vue.js');
  await page.getByLabel('Private note').fill('Private note must not be public');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.preview-panel')).toContainText('Developer links');
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Developer links', exact: true })).toBeVisible();
  const publicPage = await context.newPage();
  await publicPage.goto('/Vue42');
  await expect(
    publicPage.getByRole('heading', { name: 'Developer links', exact: true }),
  ).toBeVisible();
  await expect(publicPage.locator('body')).not.toContainText('Private note must not be public');
  const publicData = await publicPage.request.get('/api/public/sites/Vue42');
  const site = await publicData.json();
  await expect.poll(() => publicPage.evaluate(() => (window as any).testTools.size)).toBe(0);
  // The signed-in admin's own traffic is not counted; a visitor's is.
  const visitor = await context.browser()!.newContext();
  const visitorPage = await visitor.newPage();
  await visitorPage.goto('/Vue42');
  await expect(
    visitorPage.getByRole('heading', { name: 'Developer links', exact: true }),
  ).toBeVisible();
  const redirect = await visitorPage.request.get('/r/' + site.links[0].id, { maxRedirects: 0 });
  expect(redirect.status()).toBe(302);
  await visitor.close();
  await page.reload();
  await page.getByRole('link', { name: 'View analytics' }).click();
  await expect(page.locator('.stat-value').first()).toHaveText('1');
  await expect(page.locator('.stat-value').nth(1)).toHaveText('1');
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
  await page.evaluate(async (id: string) => {
    const result = await (window as any).testTools
      .get('set_private_note')
      .execute({ id, note: 'Updated by my browser agent' });
    if (result.note !== 'Updated by my browser agent')
      throw new Error('WebMCP note mutation failed');
  }, site.id);
  await publicPage.close();
  await page.getByRole('link', { name: 'Back to pages' }).click();
  await expect(
    page.getByRole('button', { name: 'Updated by my browser agent', exact: true }),
  ).toBeVisible();
  await page.locator('summary[aria-label="More actions"]').click();
  await page.getByRole('button', { name: 'Duplicate page', exact: true }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Developer links (copy)');
  await expect(page.getByLabel('Short URL slug')).not.toHaveValue('Vue42');
  await expect(page.getByLabel('Status', { exact: true })).toHaveValue('inactive');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.locator('tr').filter({ hasText: 'Developer links (copy)' }).locator('summary').click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByRole('link', { name: 'Archived', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Developer links (copy)' })).toBeVisible();
  await page.getByRole('link', { name: 'Icon rules', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Icon rules', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Agent access', exact: true }).click();
  await expect(page.getByText('connected', { exact: true })).toBeVisible();
  await page.getByLabel('Enable browser agent tools in this tab').uncheck();
  await expect.poll(() => page.evaluate(() => (window as any).testTools.size)).toBe(0);
  await page.getByLabel('Enable browser agent tools in this tab').check();
  await expect.poll(() => page.evaluate(() => (window as any).testTools.size)).toBe(19);
  await page.getByLabel('Name', { exact: true }).fill('My test agent');
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await expect(page.getByLabel('New agent token')).toHaveValue(/^lg_/);
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('No tokens yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).testTools.size)).toBe(0);
});
test('works on mobile without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your pages' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/admin-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/admin-desktop.png', fullPage: true });
});
test('uploads a PDF in the editor and downloads it under its name in every theme', async ({
  page,
}) => {
  const filename = 'Jahresbericht über 2026.pdf';
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'New page', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Reports');
  await page.getByLabel('Short URL slug').fill('Pdf42');
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: filename,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\n%%EOF\n'),
  });
  await expect(page.getByRole('link', { name: filename })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.preview-panel')).toContainText('PDF · 1 KB');
  await page.screenshot({ path: 'test-results/pdf-editor.png', fullPage: true });
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Reports' });
  await expect(row).toContainText('1 PDF');
  for (const theme of themeIds)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.evaluate(async (theme) => {
        const { csrfToken } = await (await fetch('/api/auth/session')).json();
        const sites = await (await fetch('/api/admin/sites')).json();
        const id = sites.find((s: any) => s.slug === 'Pdf42').id;
        const site = await (await fetch('/api/admin/sites/' + id)).json();
        await fetch('/api/admin/sites/' + id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ ...site, theme }),
        });
      }, theme);
      await page.emulateMedia({ colorScheme });
      await page.goto('/Pdf42');
      const card = page.getByRole('link', { name: /Jahresbericht/ });
      await expect(card).toBeVisible();
      await expect(card).toContainText('PDF · 1 KB');
      await expect(card).toHaveAttribute('download', '');
      // The meta line must stay readable against the page background in each variant.
      const colors = await page.evaluate(() => [
        getComputedStyle(document.querySelector('.collection-file .link-domain')!).color,
        getComputedStyle(document.querySelector('.public-wrap')!).backgroundColor,
      ]);
      expect(colors[0]).not.toBe(colors[1]);
      await page.screenshot({ path: `test-results/pdf-${theme}-${colorScheme}.png` });
    }
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: /Jahresbericht/ }).click();
  expect((await download).suggestedFilename()).toBe(filename);
});
test('shows the signed-in admin an archived page with a status banner in every theme', async ({
  page,
  context,
}) => {
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your pages' })).toBeVisible();
  const id = await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/auth/session')).json();
    const res = await fetch('/api/admin/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        title: 'Old links',
        slug: 'Arch42',
        status: 'archived',
        links: [{ url: 'https://example.com/old', title: 'Old link' }],
      }),
    });
    if (!res.ok) throw new Error('Fixture failed: ' + res.status);
    return (await res.json()).id;
  });
  const visitor = await context.browser()!.newContext();
  expect((await (await visitor.newPage()).goto('/Arch42'))!.status()).toBe(404);
  await visitor.close();
  // One theme change per theme keeps the run well under the admin API rate limit.
  for (const theme of themeIds) {
    await page.evaluate(
      async ({ id, theme }) => {
        const { csrfToken } = await (await fetch('/api/auth/session')).json();
        const site = await (await fetch('/api/admin/sites/' + id)).json();
        const res = await fetch('/api/admin/sites/' + id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ ...site, theme }),
        });
        if (!res.ok) throw new Error('Theme update failed: ' + res.status);
      },
      { id, theme },
    );
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto('/Arch42');
      const banner = page.getByRole('status');
      await expect(banner).toContainText('This page is archived');
      await expect(page.getByRole('link', { name: /Old link/ })).toBeVisible();
      const colors = await page.evaluate(() => [
        getComputedStyle(document.querySelector('.status-banner')!).color,
        getComputedStyle(document.querySelector('.status-banner')!).backgroundColor,
      ]);
      expect(colors[0]).not.toBe(colors[1]);
      await page.screenshot({ path: `test-results/archived-${theme}-${colorScheme}.png` });
    }
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.getByRole('status')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('assigns campaigns from both sides and serves attributed campaign URLs in every theme', async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (v: string) => ((window as any).copiedUrl = v) },
      configurable: true,
    });
  });
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Page side: create a campaign inline and make the base URL private.
  await page.getByRole('link', { name: 'New page', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('My CV');
  await page.getByLabel('Short URL slug').fill('Cv42');
  await page.getByLabel('Destination URL').fill('https://example.com/portfolio');
  await page.getByLabel('Link title').fill('Portfolio');
  await page.getByLabel('Add a campaign').fill('Example Company');
  await page.getByRole('button', { name: 'Create campaign “Example Company”' }).click();
  await expect(page.locator('.chip')).toContainText('Example Company');
  await page.getByLabel('Only reachable through campaign links').check();
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'My CV' });
  await expect(row).toContainText('Campaign links only');
  // Campaign side: change the code.
  await page.getByRole('link', { name: 'Campaigns', exact: true }).click();
  await page.getByRole('link', { name: 'Example Company', exact: true }).click();
  await page.getByLabel('Campaign code').fill('acme');
  await expect(page.getByText('will stop working when you save')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('http://localhost:3100/Cv42/acme')).toBeVisible();
  await page.getByRole('link', { name: 'Pages', exact: true }).click();
  // The only URL of a campaign-only page with one campaign is that campaign's.
  await row.getByRole('button', { name: 'Copy short URL' }).click();
  expect(await page.evaluate(() => (window as any).copiedUrl)).toBe(
    'http://localhost:3100/Cv42/acme',
  );
  expect((await page.request.get('/Cv42')).status()).toBe(404);
  const visitor = await context.browser()!.newContext({ userAgent: 'Mozilla/5.0 Chrome/150' });
  const pub = await visitor.newPage();
  // One theme change per theme keeps the run well under the admin API rate limit.
  for (const theme of themeIds) {
    await page.evaluate(async (theme) => {
      const { csrfToken } = await (await fetch('/api/auth/session')).json();
      const sites = await (await fetch('/api/admin/sites')).json();
      const id = sites.find((s: any) => s.slug === 'Cv42').id;
      const site = await (await fetch('/api/admin/sites/' + id)).json();
      const res = await fetch('/api/admin/sites/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ ...site, theme }),
      });
      if (!res.ok) throw new Error('Theme update failed: ' + res.status);
    }, theme);
    for (const colorScheme of ['light', 'dark'] as const) {
      await pub.emulateMedia({ colorScheme });
      await pub.goto('/Cv42/acme');
      const card = pub.getByRole('link', { name: /Portfolio/ });
      await expect(card).toHaveAttribute('href', /\?c=acme$/);
      await expect(pub.locator('body')).not.toContainText('Example Company');
      const colors = await pub.evaluate(() => [
        getComputedStyle(document.querySelector('.link-title')!).color,
        getComputedStyle(document.querySelector('.public-wrap')!).backgroundColor,
      ]);
      expect(colors[0]).not.toBe(colors[1]);
      await pub.screenshot({ path: `test-results/campaign-${theme}-${colorScheme}.png` });
    }
  }
  const click = await pub.request.get(
    (await pub.getByRole('link', { name: /Portfolio/ }).getAttribute('href'))!,
    { maxRedirects: 0 },
  );
  expect(click.status()).toBe(302);
  await visitor.close();
  await page.getByRole('link', { name: 'Campaigns', exact: true }).click();
  const campaignRow = page.getByRole('row').filter({ hasText: 'Example Company' });
  await expect(campaignRow.locator('.metric').first()).toHaveText(String(themeIds.length * 2));
  await expect(campaignRow.locator('.metric').nth(1)).toHaveText('1');
  // Deactivating the campaign closes the campaign-only page; restoring keeps the metrics.
  const act = async (name: string) => {
    const menu = campaignRow.locator('details.action-menu');
    if ((await menu.getAttribute('open')) === null) await menu.locator('summary').click();
    await campaignRow.getByRole('button', { name, exact: true }).click();
  };
  await act('Deactivate');
  await expect(campaignRow).toContainText('inactive');
  expect((await page.request.get('/Cv42/acme')).status()).toBe(404);
  await act('Archive');
  await expect(campaignRow).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await act('Activate / restore');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(campaignRow.locator('.metric').first()).toHaveText(String(themeIds.length * 2));
  await page.locator('nav').getByRole('link', { name: 'Pages', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: 'My CV' })
    .getByRole('link', { name: 'View analytics' })
    .click();
  await expect(page.getByRole('heading', { name: 'By campaign' })).toBeVisible();
});
test('link cards show the full URL unless a link is set to its domain', async ({ page }) => {
  await page.route('**/api/admin/metadata', (r) =>
    r.fulfill({ json: { title: 'Guide', description: '', imageUrl: '', warning: '' } }),
  );
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'New page', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('URL display');
  await page.getByLabel('Short URL slug').fill('UrlShow');
  await page.getByLabel('Destination URL').fill('https://www.example.com/guides/getting-started/');
  await page.getByLabel('Link title').click();
  const full = page.getByRole('button', { name: /Full link/ });
  const domain = page.getByRole('button', { name: /Domain only/ });
  // Each option shows the text it puts on the card.
  await expect(full).toContainText('example.com/guides/getting-started/');
  await expect(full).toHaveAttribute('aria-pressed', 'true');
  await expect(domain).toContainText('example.com');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const meta = page.locator('.preview-panel .link-domain');
  await expect(meta).toHaveText('example.com/guides/getting-started/');
  await domain.click();
  await expect(domain).toHaveAttribute('aria-pressed', 'true');
  await expect(meta).toHaveText('example.com');
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect(page.getByRole('link', { name: 'URL display', exact: true })).toBeVisible();
  await page.goto('/UrlShow');
  await expect(page.locator('.link-domain')).toHaveText('example.com');
});
