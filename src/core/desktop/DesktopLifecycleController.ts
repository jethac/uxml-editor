import type { Disposable } from '../host/HostPort';

export type DirtyState = 'clean' | 'dirty' | 'unknown';
export type CloseChoice = 'save' | 'discard' | 'cancel';
export type SaveBeforeCloseResult = 'saved' | 'cancelled' | 'failed';

export interface DesktopEvent<T> {
  readonly payload: T;
}

export interface DesktopLifecyclePorts {
  readonly events: {
    listen(
      eventName: string,
      listener: (event: DesktopEvent<unknown>) => void | Promise<void>,
    ): Promise<() => void>;
  };
  readonly dirty: { getDirtyState(): DirtyState | Promise<DirtyState> };
  readonly confirm: { confirmClose(): CloseChoice | Promise<CloseChoice> };
  readonly save: { saveBeforeClose(): SaveBeforeCloseResult | Promise<SaveBeforeCloseResult> };
  readonly window: { close(): void | Promise<void> };
}

export class DesktopLifecycleController {
  private active = false;
  private closing = false;
  private handling: Promise<void> | undefined;

  constructor(private readonly ports: DesktopLifecyclePorts) {}

  async start(): Promise<Disposable> {
    if (this.active) throw new Error('Desktop lifecycle controller is already started.');
    this.active = true;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await this.ports.events.listen('uxml://close-requested', () => this.requestClose());
    } catch (error) {
      this.active = false;
      throw error;
    }
    return Object.freeze({
      dispose: () => {
        if (!this.active) return;
        this.active = false;
        unlisten?.();
      },
    });
  }

  private async requestClose(): Promise<void> {
    if (!this.active || this.closing) return;
    if (this.handling !== undefined) return this.handling;
    const attempt = this.evaluateClose().finally(() => {
      if (this.handling === attempt) this.handling = undefined;
    });
    this.handling = attempt;
    return attempt;
  }

  private async evaluateClose(): Promise<void> {
    let dirty: DirtyState;
    try {
      dirty = await this.ports.dirty.getDirtyState();
    } catch {
      return;
    }
    if (!isDirtyState(dirty) || dirty === 'unknown') return;
    if (dirty === 'clean') return this.closeOnce();

    let choice: CloseChoice;
    try {
      choice = await this.ports.confirm.confirmClose();
    } catch {
      return;
    }
    if (!isCloseChoice(choice) || choice === 'cancel') return;
    if (choice === 'discard') return this.closeOnce();

    let saved: SaveBeforeCloseResult;
    try {
      saved = await this.ports.save.saveBeforeClose();
    } catch {
      return;
    }
    if (saved !== 'saved') return;
    try {
      if (await this.ports.dirty.getDirtyState() !== 'clean') return;
    } catch {
      return;
    }
    await this.closeOnce();
  }

  private async closeOnce(): Promise<void> {
    if (!this.active || this.closing) return;
    this.closing = true;
    try {
      await this.ports.window.close();
    } catch {
      this.closing = false;
    }
  }
}

function isDirtyState(value: unknown): value is DirtyState {
  return value === 'clean' || value === 'dirty' || value === 'unknown';
}

function isCloseChoice(value: unknown): value is CloseChoice {
  return value === 'save' || value === 'discard' || value === 'cancel';
}
