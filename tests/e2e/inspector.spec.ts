import { expect, test, type Page } from '@playwright/test';

const SHEET = 'Assets/UI/task-13.uss';

test('desktop inspector stays contained and writes the chosen authored rule at 1366x768', async ({ page }) => {
  await openInspector(page, { width: 1366, height: 768 });
  await expect(page.getByRole('application', { name: 'UXML Editor' })).toHaveAttribute('data-layout-mode', 'desktop');
  const width = page.getByRole('textbox', { name: 'Width', exact: true });
  await expect(width).toHaveValue('180px');
  await expect(width).toHaveAttribute('aria-describedby', /inspector-style-width-origin/);
  await expect(page.getByText('task-13.uss · .primary').first()).toBeVisible();
  await expectInspectorGeometry(page);

  await width.fill('240px');
  const menu = page.getByRole('menu', { name: 'Write width to' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'task-13.uss · .primary' }).click();

  await expect.poll(() => source(page, SHEET)).toContain('width: 240px;');
  expect(await undoDepth(page)).toBe(1);
  await expectInspectorGeometry(page);
});

test('compact inspector is full width, scrollable, and contained at 720x768', async ({ page }) => {
  await openInspector(page, { width: 720, height: 768 });
  await expect(page.getByRole('application', { name: 'UXML Editor' })).toHaveAttribute('data-layout-mode', 'compact');
  await expect(page.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('right-pane')).toBeVisible();
  const width = page.getByRole('textbox', { name: 'Width', exact: true });
  await width.scrollIntoViewIfNeeded();
  await expect(width).toBeVisible();
  await expectInspectorGeometry(page);

  const geometry = await page.evaluate(() => {
    const tools = document.querySelector<HTMLElement>('[data-testid="compact-tools"]');
    const pane = document.querySelector<HTMLElement>('[data-testid="right-pane"]');
    const body = pane?.querySelector<HTMLElement>('.workspace-pane-body');
    if (tools === null || pane === null || body === null) throw new Error('Missing compact inspector geometry.');
    const toolsBox = tools.getBoundingClientRect();
    const paneBox = pane.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      toolsLeft: toolsBox.left,
      toolsRight: toolsBox.right,
      paneLeft: paneBox.left,
      paneRight: paneBox.right,
      scrollable: body.scrollHeight > body.clientHeight,
      horizontalOverflow: body.scrollWidth > body.clientWidth + 1,
    };
  });
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.paneLeft).toBeCloseTo(geometry.toolsLeft, 0);
  expect(geometry.paneRight).toBeCloseTo(geometry.toolsRight, 0);
  expect(geometry.scrollable).toBe(true);
  expect(geometry.horizontalOverflow).toBe(false);
});

async function openInspector(page: Page, viewport: Readonly<{ width: number; height: number }>) {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/tests/e2e/fixtures/inspector.html');
  await expect(page.getByRole('application', { name: 'UXML Editor' })).toBeVisible();
}

async function expectInspectorGeometry(page: Page) {
  const geometry = await page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('[data-testid="right-pane"]');
    const body = pane?.querySelector<HTMLElement>('.workspace-pane-body');
    if (pane === null || body === null) throw new Error('Missing inspector pane.');
    const paneBox = pane.getBoundingClientRect();
    const fields = [...pane.querySelectorAll<HTMLElement>('.inspector-field')];
    const visible = fields.filter((field) => {
      const box = field.getBoundingClientRect();
      return box.bottom > paneBox.top && box.top < paneBox.bottom;
    });
    return {
      paneLeft: paneBox.left,
      paneRight: paneBox.right,
      bodyScrollWidth: body.scrollWidth,
      bodyClientWidth: body.clientWidth,
      visibleFields: visible.length,
      contained: visible.every((field) => {
        const box = field.getBoundingClientRect();
        return box.left >= paneBox.left - 1 && box.right <= paneBox.right + 1;
      }),
      labelsClear: visible.every((field) => {
        const label = field.querySelector<HTMLElement>('label');
        const control = field.querySelector<HTMLElement>('input, select');
        if (label === null || control === null) return true;
        const left = label.getBoundingClientRect();
        const right = control.getBoundingClientRect();
        return left.right <= right.left + 1;
      }),
    };
  });
  expect(geometry.visibleFields).toBeGreaterThan(0);
  expect(geometry.contained).toBe(true);
  expect(geometry.labelsClear).toBe(true);
  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.bodyClientWidth + 1);
}

async function source(page: Page, path: string): Promise<string> {
  return page.evaluate((requested) => (window as typeof window & {
    __task13: { source(path: string): string };
  }).__task13.source(requested), path);
}

async function undoDepth(page: Page): Promise<number> {
  return page.evaluate(() => (window as typeof window & {
    __task13: { undoDepth(): number };
  }).__task13.undoDepth());
}
