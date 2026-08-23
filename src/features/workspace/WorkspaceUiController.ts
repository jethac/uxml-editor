import type {
  CommandErrorPort,
  EditorCommandState,
  EditorUiCommandPort,
} from '../../core/store/CommandRegistry';

export interface WorkspaceCommandError {
  readonly commandId: string;
  readonly label: string;
  readonly message: string;
}

export interface WorkspaceUiSnapshot {
  readonly commandPaletteOpen: boolean;
  readonly searchRequest: number;
  readonly commandError: WorkspaceCommandError | null;
}

export class WorkspaceUiController implements EditorUiCommandPort, CommandErrorPort {
  private readonly listeners = new Map<number, () => void>();
  private nextListenerId = 1;
  private snapshot: WorkspaceUiSnapshot = Object.freeze({
    commandPaletteOpen: false,
    searchRequest: 0,
    commandError: null,
  });

  readonly getSnapshot = (): WorkspaceUiSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    const id = this.nextListenerId++;
    this.listeners.set(id, listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(id);
    };
  };

  openSearch(): void {
    this.snapshot = Object.freeze({
      commandPaletteOpen: false,
      searchRequest: this.snapshot.searchRequest + 1,
      commandError: this.snapshot.commandError,
    });
    this.publish();
  }

  openCommandPalette(): void {
    this.setOpen(true);
  }

  closeCommandPalette(): void {
    this.setOpen(false);
  }

  report(command: EditorCommandState, error: unknown): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      commandPaletteOpen: false,
      commandError: Object.freeze({
        commandId: command.id,
        label: command.label,
        message: error instanceof Error && error.message.length > 0
          ? error.message
          : 'The command could not be completed.',
      }),
    });
    this.publish();
  }

  clearCommandError(): void {
    if (this.snapshot.commandError === null) return;
    this.snapshot = Object.freeze({ ...this.snapshot, commandError: null });
    this.publish();
  }

  private setOpen(open: boolean): void {
    if (this.snapshot.commandPaletteOpen === open) return;
    this.snapshot = Object.freeze({ ...this.snapshot, commandPaletteOpen: open });
    this.publish();
  }

  private publish(): void {
    for (const listener of [...this.listeners.values()]) listener();
  }
}
