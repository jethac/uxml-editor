import { HostError, type Disposable, type DisposalOutcome } from '../host/HostPort';

export type DirtyState = 'clean' | 'dirty' | 'unknown';
export type CloseChoice = 'save' | 'discard' | 'cancel';
export type SaveBeforeCloseResult = 'saved' | 'cancelled' | 'failed';
export type CloseLease = string;
export type LifecycleGeneration = string;
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
    runExclusive(
      lease: CloseLease,
      operation: (lease: DocumentStateLease) => void | Promise<void>,
    ): void | Promise<void>;
    finalValidate(lease: DocumentStateLease): boolean | Promise<boolean>;
  };
  readonly confirm: { confirmClose(lease: CloseLease): CloseChoice | Promise<CloseChoice> };
  readonly save: { saveBeforeClose(lease: DocumentStateLease): SaveBeforeCloseResult | Promise<SaveBeforeCloseResult> };
  readonly window: {
    setLifecycleReady(generation: LifecycleGeneration, ready: boolean): void | Promise<void>;
    resolveClose(
      lease: CloseLease,
      generation: LifecycleGeneration,
      resolution: CloseResolution,
    ): void | Promise<void>;
    abandonClose?(lease: CloseLease, generation: LifecycleGeneration): void | Promise<void>;
  };
  readonly errors?: { report(error: unknown): void };
}

export class DesktopLifecycleController {
  private active = false;
  private closing = false;
  private handling: Promise<void> | undefined;
  readonly lifecycleGeneration = nextLifecycleGeneration();

  constructor(private readonly ports: DesktopLifecyclePorts) {}

  async start(): Promise<Disposable> {
    if (this.active) throw new Error('Desktop lifecycle controller is already started.');
    const generation = this.lifecycleGeneration;
    this.active = true;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await this.ports.events.listen('uxml://close-requested', ({ payload }) => {
        const request = parseCloseRequest(payload);
        if (request !== null && request.lifecycleGeneration === generation) {
          return this.requestClose(request.lease, generation);
        }
      });
      await this.ports.window.setLifecycleReady(generation, true);
    } catch (error) {
      this.active = false;
      unlisten?.();
      try {
        await this.ports.window.setLifecycleReady(generation, false);
      } catch (withdrawalError) {
        this.report(withdrawalError);
      }
      throw error;
    }
    let retirement: Promise<DisposalOutcome> | undefined;
    return Object.freeze({
      dispose: () => {
        if (!this.active) return;
        this.active = false;
        unlisten?.();
        retirement = Promise.resolve(this.ports.window.setLifecycleReady(generation, false))
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

  private async requestClose(lease: CloseLease, generation: LifecycleGeneration): Promise<void> {
    if (!this.active || this.closing) return;
    if (this.handling !== undefined) return this.handling;
    const attempt = this.evaluateClose(lease, generation).finally(() => {
      if (this.handling === attempt) this.handling = undefined;
    });
    this.handling = attempt;
    return attempt;
  }

  private async evaluateClose(lease: CloseLease, generation: LifecycleGeneration): Promise<void> {
    try {
      await this.ports.state.runExclusive(lease, async (stateLease) => {
        if (!isDocumentStateLease(stateLease) || stateLease.dirtyState === 'unknown') {
          await this.resolveOnce(lease, generation, 'cancel');
          return;
        }
        if (stateLease.dirtyState === 'clean') {
          await this.resolveValidated(lease, generation, stateLease);
          return;
        }

        let choice: CloseChoice;
        try {
          choice = await this.ports.confirm.confirmClose(lease);
        } catch {
          await this.resolveOnce(lease, generation, 'cancel');
          return;
        }
        if (!isCloseChoice(choice) || choice === 'cancel') {
          await this.resolveOnce(lease, generation, 'cancel');
          return;
        }
        if (choice === 'discard') {
          await this.resolveValidated(lease, generation, stateLease);
          return;
        }

        let saved: SaveBeforeCloseResult;
        try {
          saved = await this.ports.save.saveBeforeClose(stateLease);
        } catch {
          await this.resolveOnce(lease, generation, 'cancel');
          return;
        }
        if (saved !== 'saved') {
          await this.resolveOnce(lease, generation, 'cancel');
          return;
        }
        await this.resolveValidated(lease, generation, stateLease);
      });
    } catch (error) {
      this.report(error);
      await this.resolveOnce(lease, generation, 'cancel');
    }
  }

  private async resolveValidated(
    lease: CloseLease,
    generation: LifecycleGeneration,
    stateLease: DocumentStateLease,
  ): Promise<void> {
    try {
      if (await this.ports.state.finalValidate(stateLease)) {
        return this.resolveOnce(lease, generation, 'close');
      }
    } catch {
      // Validation errors fail closed through the native cancellation below.
    }
    await this.resolveOnce(lease, generation, 'cancel');
  }

  private async resolveOnce(
    lease: CloseLease,
    generation: LifecycleGeneration,
    resolution: CloseResolution,
  ): Promise<void> {
    if (!this.active || (resolution === 'close' && this.closing)) return;
    if (resolution === 'close') this.closing = true;
    try {
      await this.ports.window.resolveClose(lease, generation, resolution);
    } catch (error) {
      this.report(error);
      if (resolution === 'close') this.closing = false;
      if (this.ports.window.abandonClose !== undefined) {
        try {
          await this.ports.window.abandonClose(lease, generation);
        } catch (abandonError) {
          this.report(abandonError);
        }
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.ports.errors?.report(error);
    } catch {
      // Lifecycle callbacks contain error-sink failures.
    }
  }
}

function parseCloseRequest(payload: unknown): Readonly<{
  lease: CloseLease;
  lifecycleGeneration: LifecycleGeneration;
}> | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).length !== 2
    || typeof record.lease !== 'string'
    || typeof record.lifecycleGeneration !== 'string'
    || !/^close:v1:[0-9a-f]{16}$/.test(record.lease)
    || !/^lifecycle:v1:[0-9a-f]{16}$/.test(record.lifecycleGeneration)) return null;
  return Object.freeze({
    lease: record.lease,
    lifecycleGeneration: record.lifecycleGeneration,
  });
}

let lifecycleSequence = 1;

function nextLifecycleGeneration(): LifecycleGeneration {
  const sequence = lifecycleSequence;
  lifecycleSequence += 1;
  return `lifecycle:v1:${sequence.toString(16).padStart(16, '0')}`;
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
