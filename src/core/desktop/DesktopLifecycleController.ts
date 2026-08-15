import { HostError, type Disposable, type DisposalOutcome } from '../host/HostPort';

export type DirtyState = 'clean' | 'dirty' | 'unknown';
export type CloseChoice = 'save' | 'discard' | 'cancel';
export type SaveBeforeCloseResult = 'saved' | 'cancelled' | 'failed';
export type CloseLease = string;
export type CloseResolution = 'close' | 'cancel';

export interface DocumentStateLease {
  readonly generation: number;
  readonly dirtyState: DirtyState;
}

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
  readonly state: {
    acquire(lease: CloseLease): DocumentStateLease | Promise<DocumentStateLease>;
    finalValidate(lease: DocumentStateLease): boolean | Promise<boolean>;
    release(lease: DocumentStateLease): void | Promise<void>;
  };
  readonly confirm: { confirmClose(lease: CloseLease): CloseChoice | Promise<CloseChoice> };
  readonly save: { saveBeforeClose(lease: DocumentStateLease): SaveBeforeCloseResult | Promise<SaveBeforeCloseResult> };
  readonly window: {
    setLifecycleReady(ready: boolean): void | Promise<void>;
    resolveClose(lease: CloseLease, resolution: CloseResolution): void | Promise<void>;
  };
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
      await this.ports.window.setLifecycleReady(true);
    } catch (error) {
      this.active = false;
      unlisten?.();
      throw error;
    }
    let retirement: Promise<DisposalOutcome> | undefined;
    return Object.freeze({
      dispose: () => {
        if (!this.active) return;
        this.active = false;
        unlisten?.();
        retirement = Promise.resolve(this.ports.window.setLifecycleReady(false))
          .then(() => Object.freeze({ status: 'disposed' as const }))
          .catch((error) => Object.freeze({
            status: 'failed' as const,
            error: error instanceof HostError
              ? error
              : new HostError('read-failed', 'Could not withdraw desktop lifecycle readiness.', error),
          }));
      },
      get completion() {
        return retirement ?? Promise.resolve(Object.freeze({ status: 'disposed' as const }));
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
    let stateLease: DocumentStateLease;
    try {
      stateLease = await this.ports.state.acquire(lease);
    } catch {
      return this.resolveOnce(lease, 'cancel');
    }
    try {
      if (!isDocumentStateLease(stateLease) || stateLease.dirtyState === 'unknown') {
        await this.resolveOnce(lease, 'cancel');
        return;
      }
      if (stateLease.dirtyState === 'clean') {
        await this.resolveValidated(lease, stateLease);
        return;
      }

      let choice: CloseChoice;
      try {
        choice = await this.ports.confirm.confirmClose(lease);
      } catch {
        await this.resolveOnce(lease, 'cancel');
        return;
      }
      if (!isCloseChoice(choice) || choice === 'cancel') {
        await this.resolveOnce(lease, 'cancel');
        return;
      }
      if (choice === 'discard') {
        await this.resolveValidated(lease, stateLease);
        return;
      }

      let saved: SaveBeforeCloseResult;
      try {
        saved = await this.ports.save.saveBeforeClose(stateLease);
      } catch {
        await this.resolveOnce(lease, 'cancel');
        return;
      }
      if (saved !== 'saved') {
        await this.resolveOnce(lease, 'cancel');
        return;
      }
      await this.resolveValidated(lease, stateLease);
    } finally {
      try {
        await this.ports.state.release(stateLease);
      } catch {
        await this.resolveOnce(lease, 'cancel');
      }
    }
  }

  private async resolveValidated(lease: CloseLease, stateLease: DocumentStateLease): Promise<void> {
    try {
      if (await this.ports.state.finalValidate(stateLease)) {
        return this.resolveOnce(lease, 'close');
      }
    } catch {
      // Validation errors fail closed through the native cancellation below.
    }
    await this.resolveOnce(lease, 'cancel');
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

function isDocumentStateLease(value: unknown): value is DocumentStateLease {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const lease = value as Partial<DocumentStateLease>;
  return Number.isSafeInteger(lease.generation)
    && typeof lease.generation === 'number'
    && lease.generation >= 0
    && isDirtyState(lease.dirtyState);
}

function isCloseChoice(value: unknown): value is CloseChoice {
  return value === 'save' || value === 'discard' || value === 'cancel';
}
