export type UssCommandErrorCode =
  | 'invalid-target'
  | 'stale-target'
  | 'ambiguous-source'
  | 'invalid-value'
  | 'unsafe-source';

export class UssCommandError extends Error {
  constructor(readonly code: UssCommandErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'UssCommandError';
  }
}
