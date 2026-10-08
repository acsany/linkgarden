import { test, expect } from '@playwright/test';
import { themes } from '../../shared/themes';

test('icon rules preserve drafts and resolve icons in every theme', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.route('**/api/admin/metadata', (route) =>
    route.fulfill({ json: { title: 'Course', description: '', imageUrl: '', warning: '' } }),
  );
  await page.route('**/icon-test-image.png', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'New page', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Icon draft');
  await page.getByLabel('Destination URL').fill('https://realpython.com/courses/example/');
  await page.getByLabel('Link title').click();
  await expect(page.getByLabel('Link title')).toHaveValue('Course');
  await expect(page.locator('.icon-field option:checked')).toHaveText(
    'Automatic · Video or course',
  );
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('link', { name: 'icon rules', exact: true }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Icon draft');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('link', { name: 'icon rules', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Icon rules', exact: true })).toBeVisible();
  await page.getByLabel('URL', { exact: true }).fill('https://realpython.com/courses/example/');
  await expect(page.locator('.icon-test')).toContainText('Video or course');
  await page.getByText('Browse icons', { exact: false }).first().click();
  await page
    .getByRole('group', { name: 'Icon for rule 1', exact: true })
    .getByRole('button', { name: 'Book', exact: true })
    .click();
  await expect(
    page
      .getByRole('group', { name: 'Icon for rule 1', exact: true })
      .getByRole('button', { name: 'Book', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.icon-test')).toContainText('Book');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('link', { name: 'Back to pages' }).click();
  await expect(page.getByRole('combobox', { name: 'Icon for rule 1', exact: true })).toHaveValue(
    'book',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('icon-rules-320.png'), fullPage: true });
  const firstSave = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/admin/icon-rules') && response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Save rules' }).click();
  expect((await firstSave).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Save rules' })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Icon for rule 1', exact: true })).toHaveValue(
    'book',
  );
  await page
    .getByRole('combobox', { name: 'Icon for rule 1', exact: true })
    .selectOption('circle-play');
  const secondSave = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/admin/icon-rules') && response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Save rules' }).click();
  expect((await secondSave).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Save rules' })).toBeDisabled();
  await page.getByRole('link', { name: 'Back to pages' }).click();
  await page.getByRole('link', { name: 'New page', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Icons ' + testInfo.project.name);
  await page.getByLabel('Short URL slug').fill('icons-' + testInfo.project.name);
  await page.getByLabel('Destination URL').fill('https://github.com/example');
  await page.getByLabel('Link title').click();
  await expect(page.getByLabel('Link title')).toHaveValue('Course');
  await page.locator('.icon-field select').selectOption('podcast');
  await page.getByLabel('Image URL').fill('http://localhost:3100/icon-test-image.png');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.preview-panel [data-icon="podcast"]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Add section', exact: true }).click();
  await page.getByLabel('Subheadline').fill('W'.repeat(64));
  await page.locator('.section-editor summary').click();
  await page.locator('.section-editor').getByRole('button', { name: 'Class', exact: true }).click();
  await expect(page.getByLabel('Section icon', { exact: true })).toHaveValue('graduation-cap');
  await expect(
    page.locator('.preview-panel .section-rail [data-icon="graduation-cap"]'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your pages' })).toBeVisible();
  for (const theme of themes) {
    const response = await page.evaluate(
      async ({ slug, theme }) => {
        const session = await (await fetch('/api/auth/session')).json();
        const site = await (await fetch('/api/public/sites/' + slug)).json();
        const saved = await (await fetch('/api/admin/sites/' + site.id)).json();
        return (
          await fetch('/api/admin/sites/' + site.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
            body: JSON.stringify({ ...saved, theme }),
          })
        ).status;
      },
      { slug: 'icons-' + testInfo.project.name, theme: theme.id },
    );
    expect(response).toBe(200);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto('/icons-' + testInfo.project.name);
      await expect(page.locator('.collection-link [data-icon="podcast"]:visible')).toHaveCount(1);
      await expect(page.locator('.section-rail [data-icon="graduation-cap"]')).toBeVisible();
      if (theme.id === 'cv') {
        await expect(page.locator('.public-wrap')).toHaveCSS('font-family', /IBM Plex Sans/);
        // A link without a working image shows only its rail icon, no placeholder box.
        await expect(page.locator('.link-fallback:visible')).toHaveCount(0);
        await expect(page.locator('.link-rail [data-icon="podcast"]')).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath(`icons-${theme.id}-${colorScheme}.png`),
        fullPage: true,
      });
    }
  }
});
