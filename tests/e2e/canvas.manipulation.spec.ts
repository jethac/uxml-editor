import { expect, test } from '@playwright/test';

test('browser canvas nudges, drags, resizes, and duplicates through source-backed history', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/tests/e2e/fixtures/manipulation.html');
  const canvas = page.getByTestId('canvas-field');
  const target = page.getByText('Target', { exact: true });
  await expect(target).toBeVisible();

  await target.click();
  await canvas.press('Shift+ArrowRight');
  await expect.poll(() => source(page)).toContain('left: 30px; top: 30px;');
  expect(await undoDepth(page)).toBe(1);

  const targetBox = await target.boundingBox();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(targetBox!.x + 20, targetBox!.y + 20);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + 46, targetBox!.y + 35, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => undoDepth(page)).toBe(2);
  await expect.poll(() => source(page)).not.toContain('left: 30px; top: 30px;');

  const resize = page.getByRole('button', { name: 'Resize selection' });
  await expect(resize).toBeVisible();
  const resizeBox = await resize.boundingBox();
  expect(resizeBox).not.toBeNull();
  await page.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + resizeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBox!.x + resizeBox!.width / 2 + 12, resizeBox!.y + resizeBox!.height / 2 + 8);
  await page.mouse.up();
  await expect.poll(() => source(page)).toContain('width: 112px; height: 48px;');
  expect(await undoDepth(page)).toBe(3);

  await page.getByRole('button', { name: 'Duplicate selection' }).click();
  await expect.poll(() => source(page)).toContain('name="target-copy"');
  expect(await undoDepth(page)).toBe(4);
  await expect(page.getByRole('button', { name: 'Align left' })).toBeDisabled();
  await expect(page.getByTestId('canvas-overlay')).toHaveCSS('pointer-events', 'none');
});

test('browser canvas forms a Shift multi-selection, aligns it, and invokes Copy/Paste', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/tests/e2e/fixtures/manipulation.html');
  const target = page.getByText('Target', { exact: true });
  const peer = page.getByText('Peer', { exact: true });
  await expect(target).toBeVisible();

  await target.click();
  await peer.click({ modifiers: ['Shift'] });
  await expect(page.getByRole('button', { name: 'Align top' })).toBeEnabled();
  await page.getByRole('button', { name: 'Align top' }).click();

  await expect.poll(() => source(page)).toContain('name="peer" text="Peer" style="position: absolute; left: 220px; top: 30px;');
  expect(await undoDepth(page)).toBe(1);

  await target.click();
  await page.getByRole('button', { name: 'Copy selection' }).click();
  await page.getByRole('button', { name: 'Paste' }).click();
  await expect.poll(() => source(page)).toContain('name="target-copy"');
  expect(await undoDepth(page)).toBe(2);
});

test('compact canvas controls remain contained without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 768 });
  await page.goto('/tests/e2e/fixtures/manipulation.html');
  await expect(page.getByText('Target', { exact: true })).toBeVisible();

  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('[data-testid="canvas-pane"]');
    const toolbar = document.querySelector<HTMLElement>('.canvas-toolbar');
    const tools = document.querySelector<HTMLElement>('[data-testid="compact-tools"]');
    if (canvas === null || toolbar === null || tools === null) throw new Error('Missing compact layout surface.');
    const toolbarBounds = toolbar.getBoundingClientRect();
    const controls = [...toolbar.querySelectorAll<HTMLElement>('button, input, select')];
    return {
      viewportWidth: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      toolbarScrollWidth: toolbar.scrollWidth,
      toolbarClientWidth: toolbar.clientWidth,
      canvasBottom: canvas.getBoundingClientRect().bottom,
      toolsTop: tools.getBoundingClientRect().top,
      controlsContained: controls.every((control) => {
        const bounds = control.getBoundingClientRect();
        return bounds.left >= toolbarBounds.left - 1 && bounds.right <= toolbarBounds.right + 1;
      }),
    };
  });

  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.toolbarScrollWidth).toBeLessThanOrEqual(geometry.toolbarClientWidth);
  expect(geometry.canvasBottom).toBeLessThanOrEqual(geometry.toolsTop + 1);
  expect(geometry.controlsContained).toBe(true);
});

async function source(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => (window as typeof window & {
    __task12: { source(): string };
  }).__task12.source());
}

async function undoDepth(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => (window as typeof window & {
    __task12: { undoDepth(): number };
  }).__task12.undoDepth());
}
