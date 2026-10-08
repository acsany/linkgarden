import { test, expect, type Page } from '@playwright/test';

const titles = (page: Page) => page.locator('.reorder-title').allTextContents();
const row = (page: Page, title: string) =>
  page.locator('.reorder-row').filter({ has: page.getByText(title, { exact: true }) });
// Phones drag by the grip with touch; desktop browsers drag the row with the mouse.
async function drag(page: Page, from: string, above: string, touch: boolean) {
  const source = row(page, from),
    target = await row(page, above).boundingBox();
  if (!target) throw new Error('Drop target is not visible.');
  if (!touch) {
    const box = (await source.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, target.y + 4, { steps: 8 });
    await page.mouse.up();
    return;
  }
  const grip = (await source.locator('.reorder-grip').boundingBox())!;
  await page.evaluate(
    ({ x, y, toY }) => {
      const init = (clientY: number) => ({
        bubbles: true,
        pointerId: 7,
        pointerType: 'touch',
        clientX: x,
        clientY,
      });
      document.elementFromPoint(x, y)!.dispatchEvent(new PointerEvent('pointerdown', init(y)));
      for (let i = 1; i <= 8; i++)
        window.dispatchEvent(new PointerEvent('pointermove', init(y + ((toY - y) * i) / 8)));
      window.dispatchEvent(new PointerEvent('pointerup', init(toY)));
    },
    { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2, toY: target.y + 4 },
  );
}

test('reorders sections with their links and multi-selected items', async ({ page }, testInfo) => {
  const phone = testInfo.project.name.startsWith('mobile');
  if (phone) await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill('browser@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your pages' })).toBeVisible();
  const link = (title: string) => ({
    url: 'https://example.com/' + title,
    title,
    imageUrl: 'https://example.com/icon.png',
  });
  const long = 'W'.repeat(64);
  const site = await page.evaluate(
    async (payload) => {
      const session = await (await fetch('/api/auth/session')).json();
      const response = await fetch('/api/admin/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Could not create the fixture: ${response.status}`);
      return response.json();
    },
    {
      title: 'Reorder ' + testInfo.project.name,
      slug: 'reorder-' + testInfo.project.name,
      links: [
        link('Intro'),
        { kind: 'section', title: 'Alpha' },
        link('A1'),
        link(long),
        { kind: 'section', title: 'Beta' },
        link('B1'),
      ],
    },
  );
  await page.goto('/admin/sites/' + site.id + '/edit');
  await page.getByRole('button', { name: 'Reorder', exact: true }).click();
  expect(await titles(page)).toEqual(['Intro', 'Alpha', 'A1', long, 'Beta', 'B1']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // A selected section moves with its links and skips over whole groups.
  await row(page, 'Beta').locator('.reorder-pick').click();
  await page.getByRole('button', { name: 'Move selected up' }).click();
  expect(await titles(page)).toEqual(['Intro', 'Beta', 'B1', 'Alpha', 'A1', long]);
  await expect(page.getByRole('button', { name: 'Move selected up' })).toBeDisabled();
  await page.getByRole('button', { name: 'Clear selection' }).click();

  // Several links move together, in page order, into another section.
  await row(page, long).locator('.reorder-pick').click();
  await row(page, 'Intro').locator('.reorder-pick').click();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByLabel('Move selected into section').selectOption({ label: 'Beta' });
  expect(await titles(page)).toEqual(['Beta', 'B1', 'Intro', long, 'Alpha', 'A1']);

  // Collapsed sections show only their titles and still move as a group.
  await page.getByRole('button', { name: 'Collapse sections' }).click();
  expect(await titles(page)).toEqual(['Beta', 'Alpha']);
  await drag(page, 'Alpha', 'Beta', phone);
  await page.getByRole('button', { name: 'Expand sections' }).click();
  expect(await titles(page)).toEqual(['Alpha', 'A1', 'Beta', 'B1', 'Intro', long]);

  // Dragging an unselected link moves only that link.
  await drag(page, 'Intro', 'Alpha', phone);
  expect(await titles(page)).toEqual(['Intro', 'Alpha', 'A1', 'Beta', 'B1', long]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('reorder.png'), fullPage: true });

  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByLabel('Subheadline').first()).toHaveValue('Alpha');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { name: 'Your pages' })).toBeVisible();
  const saved = await page.evaluate(
    async (id) => (await (await fetch('/api/admin/sites/' + id)).json()).links,
    site.id,
  );
  expect(saved.map((l: { title: string }) => l.title)).toEqual([
    'Intro',
    'Alpha',
    'A1',
    'Beta',
    'B1',
    long,
  ]);
  // Items keep their IDs, so their clicks stay with them.
  expect(new Set(saved.map((l: { id: string }) => l.id))).toEqual(
    new Set(site.links.map((l: { id: string }) => l.id)),
  );
});
