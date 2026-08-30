import { ImmutableMap } from '../collections/ImmutableMap';
import {
  HostError,
  snapshotProjectRoot,
  type FileRevision,
  type HostPort,
  type ProjectRoot,
} from '../host/HostPort';

export interface IndexedProjectFile {
  readonly path: string;
  readonly text: string | null;
  readonly revision: FileRevision | null;
}

export class ProjectIndex {
  readonly root: ProjectRoot;
  readonly files: readonly IndexedProjectFile[];
  readonly #filesByPath: ReadonlyMap<string, IndexedProjectFile>;
  readonly #filesByFoldedPath: ReadonlyMap<string, readonly IndexedProjectFile[]>;
  readonly #resourcesByName: ReadonlyMap<string, readonly IndexedProjectFile[]>;
  readonly #resourcesByFoldedName: ReadonlyMap<string, readonly IndexedProjectFile[]>;

  private constructor(root: ProjectRoot, files: readonly IndexedProjectFile[]) {
    this.root = snapshotProjectRoot(root);
    this.files = Object.freeze([...files]);
    this.#filesByPath = new ImmutableMap(this.files.map((file) => [file.path, file]));
    const foldedGroups = new Map<string, IndexedProjectFile[]>();
    for (const file of this.files) {
      const foldedPath = file.path.toLowerCase();
      const group = foldedGroups.get(foldedPath) ?? [];
      group.push(file);
      foldedGroups.set(foldedPath, group);
    }
    this.#filesByFoldedPath = new ImmutableMap(
      [...foldedGroups].map(([path, group]) => [path, Object.freeze([...group])]),
    );
    const resources = new Map<string, IndexedProjectFile[]>();
    const foldedResources = new Map<string, IndexedProjectFile[]>();
    for (const file of this.files) {
      const logicalName = resourceLogicalName(file.path);
      if (logicalName === null) continue;
      appendGroup(resources, logicalName, file);
      appendGroup(foldedResources, logicalName.toLowerCase(), file);
    }
    this.#resourcesByName = frozenGroups(resources);
    this.#resourcesByFoldedName = frozenGroups(foldedResources);
    Object.freeze(this);
  }

  static async scan(host: HostPort, root: ProjectRoot): Promise<ProjectIndex> {
    const enumeration = await host.enumerateFiles(root);
    if (enumeration.status === 'unsupported') {
      throw new HostError('unsupported', 'Project file enumeration is unavailable for this root.');
    }
    const files: IndexedProjectFile[] = [];
    for (const path of enumeration.files) {
      if (!isProjectContentPath(path.relativePath)) continue;
      if (isTextProjectFile(path.relativePath)) {
        const read = await host.readText(path);
        files.push(Object.freeze({ path: path.relativePath, text: read.text, revision: read.revision }));
      } else {
        files.push(Object.freeze({ path: path.relativePath, text: null, revision: null }));
      }
    }
    return new ProjectIndex(root, files);
  }

  file(path: string): IndexedProjectFile | null {
    return this.#filesByPath.get(path) ?? null;
  }

  caseMatches(path: string): readonly IndexedProjectFile[] {
    return this.#filesByFoldedPath.get(path.toLowerCase()) ?? EMPTY_FILES;
  }

  resources(logicalName: string): readonly IndexedProjectFile[] {
    return this.#resourcesByName.get(logicalName) ?? EMPTY_FILES;
  }

  resourceCaseMatches(logicalName: string): readonly IndexedProjectFile[] {
    return this.#resourcesByFoldedName.get(logicalName.toLowerCase()) ?? EMPTY_FILES;
  }
}

const EMPTY_FILES: readonly IndexedProjectFile[] = Object.freeze([]);

function isProjectContentPath(path: string): boolean {
  return path.startsWith('Assets/') || path.startsWith('Packages/');
}

function isTextProjectFile(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return lowerPath.endsWith('.uxml') || lowerPath.endsWith('.uss');
}

function resourceLogicalName(path: string): string | null {
  const segments = path.split('/');
  const resourcesIndex = segments.lastIndexOf('Resources');
  if (resourcesIndex < 0 || resourcesIndex === segments.length - 1) return null;
  const relativePath = segments.slice(resourcesIndex + 1).join('/');
  const separator = relativePath.lastIndexOf('/');
  const extension = relativePath.lastIndexOf('.');
  return extension > separator + 1 ? relativePath.slice(0, extension) : relativePath;
}

function appendGroup<K>(groups: Map<K, IndexedProjectFile[]>, key: K, file: IndexedProjectFile): void {
  const group = groups.get(key) ?? [];
  group.push(file);
  groups.set(key, group);
}

function frozenGroups(
  groups: ReadonlyMap<string, readonly IndexedProjectFile[]>,
): ReadonlyMap<string, readonly IndexedProjectFile[]> {
  return new ImmutableMap([...groups].map(([key, group]) => [key, Object.freeze([...group])]));
}
