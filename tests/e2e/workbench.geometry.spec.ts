import { expect, test, type Locator, type Page } from '@playwright/test';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const desktopViewports = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1024, height: 768 },
] as const;

for (const viewport of desktopViewports) {
  test(`desktop workbench has physical non-overlapping regions at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await openWorkbench(page, viewport);
    const workbench = page.getByRole('application', { name: 'UXML Editor' });
    await expect(workbench).toHaveAttribute('data-layout-mode', 'desktop');

    const regions = await visibleRegionBoxes(page);
    expect(regions.commandbar.height).toBe(40);
    expect(regions.canvas.width).toBeGreaterThanOrEqual(96);
    expectPairwiseNoOverlap(Object.values(regions));
    expectWithinViewport(Object.values(regions), viewport);

    const separators = page.getByRole('separator');
    await expect(separators).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      const box = await visibleBox(separators.nth(index));
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
    await expectNoPageOverflow(page);
  });
}

test('desktop panel commands focus and visibly activate their target region', async ({ page }) => {
  await openWorkbench(page, { width: 1024, height: 768 });
  const command = page.getByRole('button', { name: 'Show inspector' });
  const pane = page.getByTestId('right-pane');

  await command.click();

  await expect(command).toHaveAttribute('aria-pressed', 'true');
  await expect(pane).toBeFocused();
  await expect(pane).toHaveAttribute('aria-current', 'true');
  await expect(pane).toHaveAttribute('data-active', 'true');
  const headingShadow = await pane.locator('h2').evaluate((heading) => getComputedStyle(heading).boxShadow);
  expect(headingShadow).not.toBe('none');
});

test('compact workbench has one physical tool panel below a nonzero canvas at 720x768', async ({ page }) => {
  const viewport = { width: 720, height: 768 } as const;
  await openWorkbench(page, viewport);
  const workbench = page.getByRole('application', { name: 'UXML Editor' });
  await expect(workbench).toHaveAttribute('data-layout-mode', 'compact');

  const commandbar = await visibleBox(page.getByTestId('commandbar'));
  const canvas = await visibleBox(page.getByTestId('canvas-pane'));
  const tools = await visibleBox(page.getByTestId('compact-tools'));
  expect(commandbar.height).toBe(40);
  expect(canvas.width).toBeGreaterThan(0);
  expect(canvas.height).toBeGreaterThan(0);
  expect(tools.width).toBeGreaterThan(0);
  expect(tools.height).toBeGreaterThan(0);
  expectPairwiseNoOverlap([commandbar, canvas, tools]);
  expect(commandbar.y + commandbar.height).toBeLessThanOrEqual(canvas.y);
  expect(canvas.y + canvas.height).toBeLessThanOrEqual(tools.y);
  expectWithinViewport([commandbar, canvas, tools], viewport);

  const panels = [
    page.getByTestId('left-pane'),
    page.getByTestId('right-pane'),
    page.getByTestId('bottom-pane'),
    page.getByTestId('source-pane'),
  ];
  const visibility = await Promise.all(panels.map((panel) => panel.isVisible()));
  expect(visibility.filter(Boolean)).toHaveLength(1);
  await expect(panels[0]).toBeVisible();
  for (const panel of panels.slice(1)) {
    await expect(panel).toHaveAttribute('hidden', '');
    await expect(panel).toHaveCSS('display', 'none');
    expect(await panel.boundingBox()).toBeNull();
  }

  await expect(page.getByRole('tablist', { name: 'Tool panes' })).toBeVisible();
  await expect(page.getByRole('separator')).toHaveCount(0);
  await expectNoPageOverflow(page);
});

async function openWorkbench(
  page: Page,
  viewport: Readonly<{ width: number; height: number }>,
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/');
  await expect(page.getByRole('application', { name: 'UXML Editor' })).toBeVisible();
}

async function visibleRegionBoxes(page: Page): Promise<Record<string, Box>> {
  return {
    commandbar: await visibleBox(page.getByTestId('commandbar')),
    left: await visibleBox(page.getByTestId('left-pane')),
    canvas: await visibleBox(page.getByTestId('canvas-pane')),
    right: await visibleBox(page.getByTestId('right-pane')),
    bottom: await visibleBox(page.getByTestId('bottom-pane')),
  };
}

async function visibleBox(locator: Locator): Promise<Box> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);
  return box!;
}

function expectPairwiseNoOverlap(boxes: readonly Box[]): void {
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const overlapWidth = Math.min(boxes[left].x + boxes[left].width, boxes[right].x + boxes[right].width)
        - Math.max(boxes[left].x, boxes[right].x);
      const overlapHeight = Math.min(boxes[left].y + boxes[left].height, boxes[right].y + boxes[right].height)
        - Math.max(boxes[left].y, boxes[right].y);
      expect(overlapWidth > 0 && overlapHeight > 0).toBe(false);
    }
  }
}

function expectWithinViewport(
  boxes: readonly Box[],
  viewport: Readonly<{ width: number; height: number }>,
): void {
  for (const box of boxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  }
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    bodyWidth: document.body.scrollWidth,
    bodyHeight: document.body.scrollHeight,
    viewportWidth: document.documentElement.clientWidth,
    viewportHeight: document.documentElement.clientHeight,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.viewportHeight);
  expect(dimensions.bodyHeight).toBeLessThanOrEqual(dimensions.viewportHeight);
}
