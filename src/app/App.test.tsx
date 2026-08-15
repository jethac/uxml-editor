import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EDITOR_LAYOUT_STORAGE_KEY } from '../core/store/EditorLayoutStorage';
import { EditorStore } from '../core/store/EditorStore';
import { createBrowserEditorStore } from './createBrowserEditorStore';
import { App } from './App';

describe('application workbench', () => {
  it('renders the real editor regions as the first screen without native APIs', () => {
    render(<App store={new EditorStore()} />);
    expect(screen.getByRole('application', { name: 'UXML Editor' })).toBeVisible();
    expect(screen.getByTestId('commandbar')).toBeVisible();
    expect(screen.getByTestId('canvas-pane')).toBeVisible();
  });

  it('keeps one stable EditorStore instance across rerenders', async () => {
    const user = userEvent.setup();
    const store = new EditorStore();
    const { rerender } = render(<App store={store} />);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));

    rerender(<App store={store} />);

    expect(screen.getByText('110%')).toBeVisible();
  });

  it('uses an injected EditorStore as the observable application boundary', () => {
    const store = new EditorStore();
    store.dispatch({ type: 'zoom/set', zoom: 1.5 });

    render(<App store={store} />);

    expect(screen.getByText('150%')).toBeVisible();
  });

  it('restores one browser store before StrictMode renders App', () => {
    const getItem = vi.fn(() => JSON.stringify({
      version: 1,
      panes: { left: 300, right: 320, bottom: 200 },
    }));
    const storage: Storage = {
      length: 1,
      clear: vi.fn(),
      getItem,
      key: vi.fn(() => EDITOR_LAYOUT_STORAGE_KEY),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    };
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });

    try {
      const store = createBrowserEditorStore();
      render(
        <StrictMode>
          <App store={store} />
        </StrictMode>,
      );

      expect(store.getSnapshot().panes).toEqual({ left: 300, right: 320, bottom: 200 });
      expect(getItem).toHaveBeenCalledOnce();
      expect(getItem).toHaveBeenCalledWith(EDITOR_LAYOUT_STORAGE_KEY);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(window, 'localStorage');
      else Object.defineProperty(window, 'localStorage', descriptor);
    }
  });
});
