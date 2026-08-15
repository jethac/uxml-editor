import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { InspectorStyleChoice } from './inspectorModel';

export interface StyleTargetMenuProps {
  readonly property: string;
  readonly choices: readonly InspectorStyleChoice[];
  readonly onChoose: (choice: InspectorStyleChoice) => void;
  readonly onCancel: () => void;
  readonly returnFocusId: string;
}

export function StyleTargetMenu({ property, choices, onChoose, onCancel, returnFocusId }: StyleTargetMenuProps) {
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => { items.current[0]?.focus(); }, []);
  const actionCount = choices.length + 1;
  const restoreFocus = () => queueMicrotask(() => document.getElementById(returnFocusId)?.focus());
  const cancel = () => {
    onCancel();
    restoreFocus();
  };

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = items.current.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (current + 1) % actionCount;
    else if (event.key === 'ArrowUp') next = (current - 1 + actionCount) % actionCount;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = actionCount - 1;
    else if (event.key === 'Escape') {
      cancel();
      event.preventDefault();
      return;
    }
    if (next === null) return;
    items.current[next]?.focus();
    event.preventDefault();
  };

  return (
    <div className="inspector-target-menu" role="menu" aria-label={`Write ${property} to`} onKeyDown={handleKey}>
      {choices.map((choice, index) => (
        <button
          key={choice.id}
          ref={(element) => { items.current[index] = element; }}
          type="button"
          role="menuitem"
          title={choice.title}
          onClick={() => { onChoose(choice); restoreFocus(); }}
        >
          {choice.label}
        </button>
      ))}
      <button
        ref={(element) => { items.current[choices.length] = element; }}
        type="button"
        role="menuitem"
        className="inspector-target-menu__cancel"
        onClick={cancel}
      >
        Cancel
      </button>
    </div>
  );
}
