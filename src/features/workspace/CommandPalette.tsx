import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Search } from 'lucide-react';
import type { CommandRegistry, EditorCommandState } from '../../core/store/CommandRegistry';
import type { WorkspaceUiController } from './WorkspaceUiController';

export interface CommandPaletteProps {
  readonly registry: CommandRegistry;
  readonly ui: WorkspaceUiController;
}

export function CommandPalette({ registry, ui }: CommandPaletteProps) {
  const commandSnapshot = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    search.current?.focus();
    return () => returnFocus.current?.focus();
  }, []);
  const commands = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('en-US');
    return commandSnapshot.commands.filter((command) => normalized.length === 0
      || `${command.category} ${command.label}`.toLocaleLowerCase('en-US').includes(normalized));
  }, [commandSnapshot, query]);
  const close = () => ui.closeCommandPalette();
  const execute = async (command: EditorCommandState) => {
    if (!command.enabled) return;
    close();
    await registry.execute(command.id);
  };

  return (
    <div className="command-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section
        className="command-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Command Palette"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          close();
        }}
      >
        <label className="command-dialog-search">
          <span className="visually-hidden">Search commands</span>
          <Search aria-hidden="true" size={15} />
          <input
            ref={search}
            type="search"
            aria-label="Search commands"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <div className="command-dialog-results" role="listbox" aria-label="Commands">
          {commands.map((command) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected="false"
              disabled={!command.enabled}
              onClick={() => void execute(command)}
            >
              <span>{command.label}</span>
              <small>{command.category}</small>
              {command.shortcut !== null && <kbd>{command.shortcut}</kbd>}
            </button>
          ))}
          {commands.length === 0 && <p>No matching commands</p>}
        </div>
      </section>
    </div>
  );
}
