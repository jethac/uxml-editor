import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ModalFocusOptions {
  readonly active: boolean;
  readonly container: RefObject<HTMLElement | null>;
  readonly initialFocus: RefObject<HTMLElement | null>;
  readonly onEscape: () => void;
}

export function useModalFocus({ active, container, initialFocus, onEscape }: ModalFocusOptions): void {
  const escapeAction = useRef(onEscape);
  escapeAction.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocus.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        escapeAction.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(container.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !container.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !container.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    const currentContainer = container.current;
    currentContainer?.addEventListener('keydown', handleKeyDown);
    return () => {
      currentContainer?.removeEventListener('keydown', handleKeyDown);
      returnFocus?.focus();
    };
  }, [active, container, initialFocus]);
}
