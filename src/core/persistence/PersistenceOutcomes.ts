import { HostError } from '../host/HostPort';
import type {
  ExternalChangeOutcome,
  ExternalResolutionOutcome,
  RecoveryCleanupRetryOutcome,
  SaveFailure,
  SaveOutcome,
} from './SaveCoordinatorContracts';

export function freezeSaveOutcome(
  outcome: Omit<SaveOutcome, 'recoveryRequired'>,
  cleanupPending = false,
): SaveOutcome {
  const writeState = outcome.status === 'partial'
    ? Object.freeze({
      writtenPaths: Object.freeze(outcome.files.filter((file) => file.status === 'saved').map((file) => file.path)),
      pendingPaths: Object.freeze([...outcome.dirtyPaths]),
    })
    : undefined;
  return Object.freeze({
    status: outcome.status,
    files: Object.freeze(outcome.files.map((file) => Object.freeze({
      ...file,
      ...(file.error === undefined ? {} : { error: Object.freeze({ ...file.error }) }),
    }))),
    dirtyPaths: Object.freeze([...outcome.dirtyPaths]),
    recovery: outcome.recovery,
    recoveryRequired: outcome.dirtyPaths.length > 0 || outcome.recovery === 'failed' || cleanupPending,
    ...(outcome.recoveryError === undefined ? {} : { recoveryError: Object.freeze({ ...outcome.recoveryError }) }),
    ...(writeState === undefined ? {} : { writeState }),
  });
}

export function freezeCleanupRetry(outcome: RecoveryCleanupRetryOutcome): RecoveryCleanupRetryOutcome {
  return Object.freeze({
    status: outcome.status,
    recoveryRequired: outcome.recoveryRequired,
    ...(outcome.error === undefined ? {} : { error: Object.freeze({ ...outcome.error }) }),
  });
}

export function snapshotFailure(error: unknown): SaveFailure {
  if (error instanceof HostError) return Object.freeze({ code: error.code, message: error.message });
  if (typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { message?: unknown }).message === 'string') {
    return Object.freeze({
      code: (error as { code: string }).code,
      message: (error as { message: string }).message,
    });
  }
  if (error instanceof Error) return Object.freeze({ code: 'unknown', message: error.message });
  return Object.freeze({ code: 'unknown', message: 'Unknown save failure.' });
}

export function localChangedFailure(operation: 'save' | 'reload' | 'overwrite', path: string): SaveFailure {
  const action = operation === 'save'
    ? 'preparing save'
    : operation === 'reload'
      ? 'preparing reload'
      : 'preparing overwrite';
  return Object.freeze({ code: 'local-changed', message: `Local source changed while ${action}: ${path}` });
}

export function recoveryUnsupportedFailure(): SaveFailure {
  return Object.freeze({
    code: 'recovery-unsupported',
    message: 'Durable recovery preparation is required before project writes.',
  });
}

export function freezeExternalOutcomes(
  outcomes: readonly ExternalChangeOutcome[],
): readonly ExternalChangeOutcome[] {
  return Object.freeze(outcomes.map((outcome) => Object.freeze({
    ...outcome,
    ...(outcome.error === undefined ? {} : { error: Object.freeze({ ...outcome.error }) }),
  })));
}

export function freezeExternalResolution(outcome: ExternalResolutionOutcome): ExternalResolutionOutcome {
  return Object.freeze({
    ...outcome,
    ...(outcome.error === undefined ? {} : { error: Object.freeze({ ...outcome.error }) }),
  });
}
