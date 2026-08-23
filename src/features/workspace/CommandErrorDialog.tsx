import { useRef } from 'react';
import type { WorkspaceCommandError, WorkspaceUiController } from './WorkspaceUiController';
import { useModalFocus } from './useModalFocus';

export interface CommandErrorDialogProps {
  readonly error: WorkspaceCommandError;
  readonly ui: WorkspaceUiController;
}

export function CommandErrorDialog({ error, ui }: CommandErrorDialogProps) {
  const dialog = useRef<HTMLElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  const close = () => ui.clearCommandError();
  useModalFocus({ active: true, container: dialog, initialFocus: dismiss, onEscape: close });
  return (
    <div className="command-dialog-backdrop">
      <section ref={dialog} className="command-dialog" role="alertdialog" aria-modal="true" aria-label="Command failed">
        <header>
          <h2>{error.label} failed</h2>
        </header>
        <p>{error.message}</p>
        <button ref={dismiss} type="button" onClick={close}>
          Dismiss
        </button>
      </section>
    </div>
  );
}
