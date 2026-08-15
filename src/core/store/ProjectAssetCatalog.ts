export interface ProjectAsset {
  readonly path: string;
  readonly resourceKey?: string;
}

export function copyProjectAssetCatalog(candidate: unknown): readonly ProjectAsset[] {
  if (!Array.isArray(candidate)) throw new TypeError('Project assets must be an array.');
  const seen = new Set<string>();
  const resources = new Map<string, string>();
  return Object.freeze(candidate.map((value) => {
    if (typeof value !== 'string' || !isProjectAssetPath(value) || seen.has(value)) {
      throw new TypeError('Project asset paths must be unique deterministic Assets or Packages file paths.');
    }
    seen.add(value);
    const resourceKey = resourceKeyFor(value);
    if (resourceKey !== null) {
      const existing = resources.get(resourceKey);
      if (existing !== undefined) {
        throw new TypeError(`Ambiguous project resource key "${resourceKey}" is derived from "${existing}" and "${value}".`);
      }
      resources.set(resourceKey, value);
    }
    return Object.freeze({ path: value, ...(resourceKey === null ? {} : { resourceKey }) });
  }));
}

export function emptyProjectAssetCatalog(): readonly ProjectAsset[] {
  return Object.freeze([]);
}

export function equalProjectAssetCatalog(left: readonly ProjectAsset[], right: readonly ProjectAsset[]): boolean {
  return left.length === right.length && left.every((asset, index) =>
    asset.path === right[index].path && asset.resourceKey === right[index].resourceKey
  );
}

function isProjectAssetPath(path: string): boolean {
  if (path.trim() !== path || path.includes('\\') || /[\u0000-\u001f]/.test(path)) return false;
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return false;
  if (segments.some((segment) => !/^[A-Za-z0-9_.@+ -]+$/.test(segment))) return false;
  if (segments[0] === 'Assets') return segments.length >= 2 && hasFileExtension(segments.at(-1)!);
  return segments[0] === 'Packages' && segments.length >= 3 && hasFileExtension(segments.at(-1)!);
}

function hasFileExtension(segment: string): boolean {
  const dot = segment.lastIndexOf('.');
  return dot > 0 && dot < segment.length - 1;
}

function resourceKeyFor(path: string): string | null {
  const segments = path.split('/');
  const resources = segments.lastIndexOf('Resources');
  if (resources < 0 || resources === segments.length - 1) return null;
  const keySegments = segments.slice(resources + 1);
  const file = keySegments.at(-1)!;
  keySegments[keySegments.length - 1] = file.slice(0, file.lastIndexOf('.'));
  return keySegments.join('/');
}
