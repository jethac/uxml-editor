import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test('workflow has no automated axe violations and is keyboard operable', async ({ page }, testInfo) => {
  await openDemoWorkflow(page, { width: 1366, height: 768 });
  await expect(page.getByRole('button', { name: 'Open Project' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Project status')).toContainText('Demo Project');
  await expect(page.getByTestId('canvas-renderer')).not.toBeEmpty();

  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);

  const canvas = page.getByLabel('Canvas editing area');
  await canvas.focus();
  await page.keyboard.press('Control+Shift+P');
  await expect(page.getByRole('searchbox', { name: 'Search commands' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(canvas).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(canvas).toBeFocused();

  await expectNoOverflowOrBlankCanvas(page);
  await page.screenshot({ path: testInfo.outputPath('task-16-desktop.png'), fullPage: true });
});

test('720px workflow stays contained with stable disabled controls', async ({ page }, testInfo) => {
  await openDemoWorkflow(page, { width: 720, height: 768 });
  const save = page.getByRole('button', { name: 'Save' });
  const before = await save.boundingBox();
  expect(before).not.toBeNull();
  expect(await save.isDisabled()).toBe(true);
  await page.getByRole('button', { name: 'Open Project' }).click();
  await expect(save).toBeEnabled();
  const after = await save.boundingBox();
  expect(after).toEqual(before);

  const workbench = page.getByRole('application', { name: 'UXML Editor' });
  await expect(workbench).toHaveAttribute('data-layout-mode', 'compact');
  await expectNoOverflowOrBlankCanvas(page);
  await page.screenshot({ path: testInfo.outputPath('task-16-720px.png'), fullPage: true });
});

test('hierarchy keyboard navigation and inspector controls retain accessible labels', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/tests/e2e/fixtures/inspector.html');
  const tree = page.getByRole('tree', { name: 'Document hierarchy' });
  const first = tree.getByRole('treeitem').first();
  await first.focus();
  if (await first.getAttribute('aria-expanded') === 'false') {
    await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem').nth(2)).toBeFocused();

  await page.getByRole('button', { name: 'Show inspector' }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('primary');
  await expect(page.getByRole('textbox', { name: 'Classes' })).toHaveValue('primary action');
  await expect(page.getByRole('button', { name: 'Remove selected' })).toHaveAttribute('title', 'Remove selected');
});

async function openDemoWorkflow(page: Page, viewport: Readonly<{ width: number; height: number }>): Promise<void> {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    window.localStorage.clear();
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: undefined });
  });
  await page.goto('/');
  await expect(page.getByRole('application', { name: 'UXML Editor' })).toBeVisible();
  await page.keyboard.press('Tab');
}

async function expectNoOverflowOrBlankCanvas(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('[data-testid="canvas-pane"]');
    const renderer = document.querySelector<HTMLElement>('[data-testid="canvas-renderer"]');
    if (canvas === null || renderer === null) throw new Error('Missing canvas geometry.');
    const canvasBox = canvas.getBoundingClientRect();
    const rendererBox = renderer.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      canvasWidth: canvasBox.width,
      canvasHeight: canvasBox.height,
      rendererWidth: rendererBox.width,
      rendererHeight: rendererBox.height,
    };
  });
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.canvasWidth).toBeGreaterThan(0);
  expect(geometry.canvasHeight).toBeGreaterThan(0);
  expect(geometry.rendererWidth).toBeGreaterThan(0);
  expect(geometry.rendererHeight).toBeGreaterThan(0);
}
