import type { DocumentSession } from '../documents/DocumentSession';
import {
  HostError,
  projectPath,
  type FileReadResult,
  type FileRevision,
  type ProjectPath,
  type ProjectRoot,
} from '../host/HostPort';
import { comparePaths } from './SessionPersistenceSnapshot';

export interface SavedFileState {
  readonly path: ProjectPath;
  readonly text: string;
  readonly revision: FileRevision;
}

export class SavedFileRegistry {
  private readonly files = new Map<string, SavedFileState>();

  constructor(root: ProjectRoot, initialFiles: readonly FileReadResult[]) {
    for (const file of initialFiles) {
      if (file.path.projectId !== root.id) {
        throw new HostError('root-not-granted', `Initial file belongs to another project root: ${file.path.projectId}`);
      }
      const path = projectPath(root, file.path.relativePath);
      this.files.set(path.relativePath, Object.freeze({ path, text: file.text, revision: file.revision }));
    }
  }

  get(path: string): SavedFileState | undefined { return this.files.get(path); }

  has(path: string): boolean { return this.files.has(path); }

  publish(path: string, text: string, revision: FileRevision): void {
    const baseline = this.files.get(path);
    if (!baseline) throw new Error(`Save baseline is missing for ${path}.`);
    this.files.set(path, Object.freeze({ path: baseline.path, text, revision }));
  }

  dirtyPaths(session: DocumentSession): readonly string[] {
    const snapshot = session.snapshot();
    return Object.freeze([...snapshot.files]
      .filter(([path, buffer]) => this.files.get(path)?.text !== buffer.text)
      .map(([path]) => path)
      .sort(comparePaths));
  }

  baseTextFiles(overrides: ReadonlyMap<string, string> = new Map()): ReadonlyMap<string, string> {
    return new Map([...this.files]
      .sort(([left], [right]) => comparePaths(left, right))
      .map(([path, file]) => [path, overrides.get(path) ?? file.text]));
  }
}
