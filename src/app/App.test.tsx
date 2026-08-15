import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { EditorStore } from '../core/store/EditorStore';
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
});
