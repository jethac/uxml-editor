import type { DocumentSession } from '../documents/DocumentSession';

export function sessionMatches(session: DocumentSession, generation: number, path: string, text: string): boolean {
  return session.generation === generation && session.snapshot().files.get(path)?.text === text;
}

export function snapshotFilesMatch(
  session: DocumentSession,
  expected: ReturnType<DocumentSession['snapshot']>,
): boolean {
  const current = session.snapshot();
  if (current.entryPath !== expected.entryPath || current.files.size !== expected.files.size) return false;
  for (const [path, buffer] of expected.files) {
    if (current.files.get(path)?.text !== buffer.text) return false;
  }
  return true;
}

export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
