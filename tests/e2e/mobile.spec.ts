import { test, expect, type Page } from '@playwright/test';

async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function fixture(page: Page, payload: object) {
  return page.evaluate(async (payload) => {
    const session = await (await fetch('/api/auth/session')).json();
    const response = await fetch('/api/admin/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Could not create mobile fixture: ${response.status}`);
    return response.json();
  }, payload);
}
test('phone workflow has visible actions and copies saved URLs in overview, editor, and analytics', async ({
  page,
  browserName,
}) => {
  const slug = browserName === 'webkit' ? 'PhoneWk' : 'PhoneCr';
  await page.setViewportSize({ width: 320, height: 740 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (value: string) => {
          (window as any).copiedUrl = value;
        },
      },
      configurable: true,
    });
  });
  await page.route('**/api/admin/metadata', (route) =>
    route.fulfill({ json: { title: 'Phone link', description: '', imageUrl: '', warning: '' } }),
  );
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your pages' })).toBeVisible();
  await fits(page);
  await page.getByRole('button', { name: 'Install Linkgarden' }).click();
  // An actual install prompt is browser/OS-controlled; fallback guidance is available.
  const help = page.getByRole('dialog', { name: 'Linkgarden on your phone' });
  if (await help.isVisible()) await page.getByRole('button', { name: 'Got it' }).click();
  await page.getByRole('link', { name: 'New page', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Links from my phone ' + browserName);
  await page.getByLabel('Short URL slug').fill(slug);
  await page.getByLabel('Destination URL').fill('https://example.com/phone');
  await page.getByLabel('Link title').fill('Example');
  await page.getByLabel('Image URL').fill('https://example.com/phone.png');
  await page.getByLabel('Private note').fill('Created on a phone');
  await fits(page);
  expect(
    await page
      .getByLabel('Short URL slug')
      .evaluate((element) => getComputedStyle(element).fontSize),
  ).toBe('16px');
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  const card = page
    .locator('.pages-table tr')
    .filter({ hasText: 'Links from my phone ' + browserName });
  await expect(card).toBeVisible();
  // An agent reading the page as Markdown shows up in the overview row. It sends no
  // admin cookie, since the admin's own reads are not counted.
  const markdown = await page.evaluate(
    async (slug) => (await fetch('/' + slug + '.md', { credentials: 'omit' })).text(),
    slug,
  );
  expect(markdown).toContain('# Links from my phone ' + browserName);
  await page.reload();
  await expect(card.locator('.agent-visits')).toHaveText('1');
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await fits(page);
    const copy = card.getByRole('button', { name: 'Copy short URL' });
    const box = await copy.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await copy.click();
    expect(await page.evaluate(() => (window as any).copiedUrl)).toBe(
      'http://localhost:3100/' + slug,
    );
  }
  await page.screenshot({ path: `test-results/phone-${browserName}.png`, fullPage: true });
  await card.getByRole('link', { name: 'Edit page' }).click();
  await expect(page.locator('.saved-url')).toContainText('/' + slug);
  await page.getByLabel('Short URL slug').fill(slug + 'Next');
  await page.getByRole('button', { name: 'Copy short URL' }).click();
  expect(await page.evaluate(() => (window as any).copiedUrl)).toBe(
    'http://localhost:3100/' + slug,
  );
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await fits(page);
  await page.getByLabel('Private note').fill('Edited on a phone');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await card.getByRole('link', { name: 'View analytics' }).click();
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
  await expect(page.getByText('1 by agents')).toBeVisible();
  await expect(page.getByText('Agent read (Markdown)')).toBeVisible();
  await fits(page);
  await page.getByLabel('Analytics period').selectOption('365');
  await expect(page.locator('.chart-day')).toHaveCount(365);
  await fits(page);
  await page.getByRole('button', { name: 'Copy short URL' }).click();
  expect(await page.evaluate(() => (window as any).copiedUrl)).toBe(
    'http://localhost:3100/' + slug + 'Next',
  );
  await page.getByRole('link', { name: 'Back to pages' }).click();
  await card.locator('summary').click();
  await card.getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByRole('link', { name: 'Archived', exact: true }).click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Copy short URL' }).click();
  expect(await page.evaluate(() => (window as any).copiedUrl)).toBe(
    'http://localhost:3100/' + slug + 'Next',
  );
  await page.getByRole('link', { name: 'Icon rules', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Icon rules', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Agent access', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Phone agent ' + browserName);
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await expect(page.getByLabel('New agent token')).toHaveValue(/^lg_/);
  await page.setViewportSize({ width: 320, height: 740 });
  await fits(page);
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await fixture(page, {
    title: 'Campaign target ' + browserName,
    slug: slug + 'Cmp',
    links: [{ url: 'https://example.com/campaign', title: 'Example' }],
  });
  await page.getByRole('link', { name: 'Campaigns', exact: true }).click();
  await page.getByRole('link', { name: 'New campaign', exact: true }).click();
  await page
    .getByLabel('Name', { exact: true })
    .fill('A recipient with a long name ' + browserName);
  await page
    .getByLabel('Page to assign')
    .selectOption({ label: `Campaign target ${browserName} (/${slug}Cmp)` });
  await page.getByRole('button', { name: 'Create campaign', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'By page' })).toBeVisible();
  await fits(page);
  await page.getByRole('link', { name: 'Back to campaigns' }).click();
  await expect(
    page.getByRole('link', { name: 'A recipient with a long name ' + browserName }),
  ).toBeVisible();
  await fits(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('copy has a selectable fallback when clipboard access is denied', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Denied');
        },
      },
      configurable: true,
    });
    document.execCommand = () => false;
  });
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Archived', exact: true }).click();
  await fixture(page, {
    title: 'Clipboard fallback fixture',
    status: 'archived',
    links: [
      { url: 'https://example.com', title: 'Example', imageUrl: 'https://example.com/icon.png' },
    ],
  });
  await page.reload();
  await page.getByRole('button', { name: 'Copy short URL' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Copy short URL' })).toBeVisible();
  await expect(page.getByLabel('Short URL to copy')).toHaveValue(/^http:\/\/localhost:3100\//);
  expect(
    await page
      .getByLabel('Short URL to copy')
      .evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!),
  ).toBeGreaterThan(5);
  await fits(page);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
});
test('long custom URLs and public video collections fit a small phone', async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.route('https://images.example.com/**', (route) =>
    route.fulfill({ status: 404, body: '' }),
  );
  await page.route('https://www.youtube-nocookie.com/embed/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body>Test video player</body></html>',
    }),
  );
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const title = browserName + 'Phone' + 'LongTitle'.repeat(20);
  await expect(page.getByRole('heading', { name: 'Your pages' })).toBeVisible();
  const slug = 'admin' + (browserName === 'webkit' ? 'W' : 'M').repeat(59);
  const site = await fixture(page, {
    title,
    slug,
    note: 'Private mobile video note',
    links: [
      {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Video'.repeat(30),
        description: 'Description'.repeat(40),
        imageUrl: 'https://images.example.com/video.png',
        embed: true,
      },
    ],
  });
  await page.reload();
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  await fits(page);
  await page.getByRole('link', { name: title, exact: true }).click();
  await expect(page.locator('.saved-url')).toContainText(slug);
  await fits(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.goto('/' + site.slug);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Private mobile video note');
  await fits(page);
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: /^Play / }).tap();
  await expect(page.locator('iframe')).toBeVisible();
  await fits(page);
});
