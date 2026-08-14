import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('application shell', () => {
  it('renders the editor workbench without native APIs', () => {
    render(<App />);
    expect(screen.getByRole('application', { name: 'UXML Editor' })).toBeVisible();
  });

  it('does not expose the empty command bar as a toolbar', () => {
    render(<App />);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });
});
