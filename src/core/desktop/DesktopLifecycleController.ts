import type { Disposable } from '../host/HostPort';

export type DirtyState = 'clean' | 'dirty' | 'unknown';
export type CloseChoice = 'save' | 'discard' | 'cancel';
export type SaveBeforeCloseResult = 'saved' | 'cancelled' | 'failed';
export type CloseLease = string;
export type CloseResolution = 'close' | 'cancel';

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
  readonly dirty: { getDirtyState(lease: CloseLease): DirtyState | Promise<DirtyState> };
  readonly confirm: { confirmClose(lease: CloseLease): CloseChoice | Promise<CloseChoice> };
  readonly save: { saveBeforeClose(lease: CloseLease): SaveBeforeCloseResult | Promise<SaveBeforeCloseResult> };
  readonly window: { resolveClose(lease: CloseLease, resolution: CloseResolution): void | Promise<void> };
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
      unlisten = await this.ports.events.listen('uxml://close-requested', ({ payload }) => {
        const lease = parseCloseLease(payload);
        if (lease !== null) return this.requestClose(lease);
      });
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

  private async requestClose(lease: CloseLease): Promise<void> {
    if (!this.active || this.closing) return;
    if (this.handling !== undefined) return this.handling;
    const attempt = this.evaluateClose(lease).finally(() => {
      if (this.handling === attempt) this.handling = undefined;
    });
    this.handling = attempt;
    return attempt;
  }

  private async evaluateClose(lease: CloseLease): Promise<void> {
    let dirty: DirtyState;
    try {
      dirty = await this.ports.dirty.getDirtyState(lease);
    } catch {
      return this.resolveOnce(lease, 'cancel');
    }
    if (!isDirtyState(dirty) || dirty === 'unknown') return this.resolveOnce(lease, 'cancel');
    if (dirty === 'clean') return this.resolveOnce(lease, 'close');

    let choice: CloseChoice;
    try {
      choice = await this.ports.confirm.confirmClose(lease);
    } catch {
      return this.resolveOnce(lease, 'cancel');
    }
    if (!isCloseChoice(choice) || choice === 'cancel') return this.resolveOnce(lease, 'cancel');
    if (choice === 'discard') return this.resolveOnce(lease, 'close');

    let saved: SaveBeforeCloseResult;
    try {
      saved = await this.ports.save.saveBeforeClose(lease);
    } catch {
      return this.resolveOnce(lease, 'cancel');
    }
    if (saved !== 'saved') return this.resolveOnce(lease, 'cancel');
    try {
      if (await this.ports.dirty.getDirtyState(lease) !== 'clean') {
        return this.resolveOnce(lease, 'cancel');
      }
    } catch {
      return this.resolveOnce(lease, 'cancel');
    }
    await this.resolveOnce(lease, 'close');
  }

  private async resolveOnce(lease: CloseLease, resolution: CloseResolution): Promise<void> {
    if (!this.active || (resolution === 'close' && this.closing)) return;
    if (resolution === 'close') this.closing = true;
    try {
      await this.ports.window.resolveClose(lease, resolution);
    } catch {
      if (resolution === 'close') this.closing = false;
    }
  }
}

function parseCloseLease(payload: unknown): CloseLease | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.lease !== 'string') return null;
  return /^close:v1:[0-9a-f]{16}$/.test(record.lease) ? record.lease : null;
}

function isDirtyState(value: unknown): value is DirtyState {
  return value === 'clean' || value === 'dirty' || value === 'unknown';
}

function isCloseChoice(value: unknown): value is CloseChoice {
  return value === 'save' || value === 'discard' || value === 'cancel';
}
