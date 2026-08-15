import type { EditorUiCommandPort } from '../../core/store/CommandRegistry';

export interface WorkspaceUiSnapshot {
  readonly commandPaletteOpen: boolean;
  readonly searchRequest: number;
}

export class WorkspaceUiController implements EditorUiCommandPort {
  private readonly listeners = new Map<number, () => void>();
  private nextListenerId = 1;
  private snapshot: WorkspaceUiSnapshot = Object.freeze({ commandPaletteOpen: false, searchRequest: 0 });

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
    });
    this.publish();
  }

  openCommandPalette(): void {
    this.setOpen(true);
  }

  closeCommandPalette(): void {
    this.setOpen(false);
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
