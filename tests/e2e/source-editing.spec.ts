import { expect, test, type Page } from '@playwright/test';

const ENTRY = 'Assets/UI/task-14.uxml';

test('desktop source authoring stays contained and recovers a malformed draft without history corruption', async ({ page }) => {
  await openSourceFixture(page, { width: 1366, height: 768 });
  await page.getByRole('tab', { name: 'Source' }).click();
  const editor = page.getByRole('textbox', { name: `${ENTRY} source` });
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Source workflow');
  await expect(page.getByTestId('canvas-renderer')).not.toBeEmpty();
  await expectSourceGeometry(page, 'desktop');

  await editor.fill('<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:Button');
  await expect(page.getByText('Stale preview', { exact: true })).toBeVisible();
  await expect(page.getByTestId('canvas-field')).toHaveAttribute('data-source-status', 'stale');
  expect(await source(page, ENTRY)).toContain('Source workflow');
  expect(await undoDepth(page)).toBe(0);

  await page.getByRole('tab', { name: 'Diagnostics' }).click();
  await page.getByRole('button', { name: /unterminated open tag/i }).click();
  await expect(page.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true');
  const original = await page.evaluate(() => (window as typeof window & {
    __task14: { original: string };
  }).__task14.original);
  await editor.fill(original.replace('Source workflow', 'Recovered source'));
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await expect(page.getByTestId('canvas-field')).toHaveAttribute('data-source-status', 'ready');
  await expect.poll(() => source(page, ENTRY)).toContain('Recovered source');
  expect(await undoDepth(page)).toBe(1);
  await expectSourceGeometry(page, 'desktop');
});

test('compact source is the fourth tab inside the single contained tool region', async ({ page }) => {
  await openSourceFixture(page, { width: 720, height: 768 });
  const tabs = page.getByRole('tablist', { name: 'Tool panes' });
  await expect(tabs.getByRole('tab')).toHaveCount(4);
  await tabs.getByRole('tab', { name: 'Source' }).click();
  await expect(page.getByTestId('source-pane')).toBeVisible();
  await expect(page.getByRole('textbox', { name: `${ENTRY} source` })).toBeVisible();

  const visibility = await Promise.all([
    page.getByTestId('left-pane'),
    page.getByTestId('right-pane'),
    page.getByTestId('bottom-pane'),
    page.getByTestId('source-pane'),
  ].map((pane) => pane.isVisible()));
  expect(visibility.filter(Boolean)).toHaveLength(1);
  await expectSourceGeometry(page, 'compact');
});

async function openSourceFixture(page: Page, viewport: Readonly<{ width: number; height: number }>) {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/tests/e2e/fixtures/source.html');
  await expect(page.getByRole('application', { name: 'UXML Editor' })).toBeVisible();
}

async function expectSourceGeometry(page: Page, mode: 'desktop' | 'compact') {
  const geometry = await page.evaluate((layoutMode) => {
    const pane = document.querySelector<HTMLElement>(layoutMode === 'desktop'
      ? '[data-testid="bottom-pane"]'
      : '[data-testid="source-pane"]');
    const editor = pane?.querySelector<HTMLElement>('.source-editor');
    const cm = pane?.querySelector<HTMLElement>('.cm-editor');
    const scroller = pane?.querySelector<HTMLElement>('.cm-scroller');
    if (pane === null || editor === null || cm === null || scroller === null) throw new Error('Missing source geometry.');
    const paneBox = pane.getBoundingClientRect();
    const editorBox = editor.getBoundingClientRect();
    const cmBox = cm.getBoundingClientRect();
    return {
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      editorWidth: editorBox.width,
      editorHeight: editorBox.height,
      contained: editorBox.left >= paneBox.left - 1
        && editorBox.right <= paneBox.right + 1
        && editorBox.top >= paneBox.top - 1
        && editorBox.bottom <= paneBox.bottom + 1
        && cmBox.bottom <= paneBox.bottom + 1,
      horizontalOverflow: scroller.scrollWidth > scroller.clientWidth + 1,
    };
  }, mode);
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.editorWidth).toBeGreaterThan(100);
  expect(geometry.editorHeight).toBeGreaterThan(40);
  expect(geometry.contained).toBe(true);
  expect(geometry.horizontalOverflow).toBe(false);
}

async function source(page: Page, path: string): Promise<string> {
  return page.evaluate((requestedPath) => (window as typeof window & {
    __task14: { source: (path: string) => string };
  }).__task14.source(requestedPath), path);
}

async function undoDepth(page: Page): Promise<number> {
  return page.evaluate(() => (window as typeof window & {
    __task14: { undoDepth: () => number };
  }).__task14.undoDepth());
}
