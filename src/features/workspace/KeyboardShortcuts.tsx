import { useEffect } from 'react';
import type { CommandRegistry, EditorCommandState } from '../../core/store/CommandRegistry';

export interface KeyboardShortcutsProps {
  readonly registry: CommandRegistry;
  readonly onError?: (error: unknown) => void;
}

export function KeyboardShortcuts({ registry, onError }: KeyboardShortcutsProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || editableTarget(event.target)) return;
      const command = registry.getSnapshot().commands.find((candidate) => (
        candidate.enabled && matchesShortcut(candidate, event)
      ));
      if (command === undefined) return;
      event.preventDefault();
      void registry.execute(command.id).catch((error) => {
        try { onError?.(error); } catch { /* Shortcut errors stay contained at the UI boundary. */ }
      });
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onError, registry]);

  return null;
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
  return event.ctrlKey === required.has('Ctrl')
    && event.metaKey === required.has('Meta')
    && event.shiftKey === required.has('Shift')
    && event.altKey === required.has('Alt')
    && normalizeKey(event.key) === normalizeKey(expectedKey);
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLocaleUpperCase('en-US') : key;
}
