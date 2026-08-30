export type UxmlCommandErrorCode =
  | 'invalid-locator'
  | 'unresolved-locator'
  | 'invalid-name'
  | 'invalid-value'
  | 'invalid-index'
  | 'invalid-fragment'
  | 'invalid-selection'
  | 'illegal-hierarchy'
  | 'illegal-root'
  | 'ambiguous-source'
  | 'missing-attribute';

export class UxmlCommandError extends Error {
  constructor(readonly code: UxmlCommandErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'UxmlCommandError';
  }
}
