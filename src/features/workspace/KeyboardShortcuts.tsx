import { useEffect } from 'react';
import type { CommandRegistry, EditorCommandState } from '../../core/store/CommandRegistry';

export interface KeyboardShortcutsProps {
  readonly registry: CommandRegistry;
}

export function KeyboardShortcuts({ registry }: KeyboardShortcutsProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = registry.getSnapshot().commands.find((candidate) => (
        candidate.enabled && matchesShortcut(candidate, event)
      ));
      if (command === undefined || (editableTarget(event.target) && conflictsWithEditableTarget(command.id))) {
        return;
      }
      event.preventDefault();
      void registry.execute(command.id);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [registry]);

  return null;
}

function conflictsWithEditableTarget(commandId: EditorCommandState['id']): boolean {
  return commandId.startsWith('edit.') || commandId === 'view.search';
}

function editableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest([
    'input',
    'textarea',
    'select',
    '[contenteditable]:not([contenteditable="false"])',
    '.cm-editor',
  ].join(',')) !== null;
}

function matchesShortcut(command: EditorCommandState, event: KeyboardEvent): boolean {
  const shortcut = command.shortcut;
  if (shortcut === null) return false;
  const parts = shortcut.split('+');
  const required = new Set(parts.slice(0, -1));
  const expectedKey = parts.at(-1) === '' ? '+' : parts.at(-1)!;
  const requiresPhysicalShift = expectedKey === '+';
  return event.ctrlKey === required.has('Ctrl')
    && event.metaKey === required.has('Meta')
    && event.shiftKey === (required.has('Shift') || requiresPhysicalShift)
    && event.altKey === required.has('Alt')
    && normalizeKey(event.key) === normalizeKey(expectedKey);
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLocaleUpperCase('en-US') : key;
}
