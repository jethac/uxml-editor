import { HostError, projectPath } from '../host/HostPort';
import type { ResolvedText } from '../adapter/types';
import type { ProjectIndex } from './ProjectIndex';
import {
  decodeParsedProjectReference,
  decodeProjectReference,
  type ProjectReferenceDecodeResult,
} from './ProjectReferenceDecoder';

export type ResolutionDiagnosticCode =
  | 'ambiguous-resource'
  | 'ambiguous-parent'
  | 'case-mismatch'
  | 'malformed-reference'
  | 'missing-file'
  | 'missing-resource'
  | 'root-escape';

export interface ResolutionDiagnostic {
  readonly code: ResolutionDiagnosticCode;
  readonly reference: string;
  readonly from: string | null;
  readonly candidates: readonly string[];
  readonly message: string;
}

export type ResolutionDiagnosticReporter = (diagnostic: ResolutionDiagnostic) => void;
export type ImportResolverHook = (url: string, from: string | null) => ResolvedText | null;
export type AssetResolverHook = (path: string, form: 'url' | 'resource') => string | null;

export type ResolvedResolutionOutcome = Readonly<{
  readonly status: 'resolved';
  readonly path: string;
  readonly text: string | null;
  readonly diagnostic: null;
}>;

export type UnresolvedResolutionOutcome = Readonly<{
  readonly status: 'unresolved';
  readonly path: null;
  readonly text: null;
  readonly diagnostic: ResolutionDiagnostic;
}>;

export type ResolutionOutcome = ResolvedResolutionOutcome | UnresolvedResolutionOutcome;

export class PathResolver {
  constructor(readonly index: ProjectIndex) {
    Object.freeze(this);
  }

  resolveImport(reference: string, from: string | null): ResolutionOutcome {
    return this.resolveProjectFile(reference, from, true, 'raw');
  }

  resolveAsset(reference: string, from: string | null): ResolutionOutcome {
    return this.resolveProjectFile(reference, from, false, 'raw');
  }

  resolveResource(reference: string, from: string | null = null): ResolutionOutcome {
    return this.resolveResourceReference(reference, from, 'raw');
  }

  private resolveResourceReference(
    reference: string,
    from: string | null,
    input: 'parsed' | 'raw',
  ): ResolutionOutcome {
    const decoded = decodeReference(reference, from, input);
    if (decoded.status === 'unresolved') return decoded;
    let logicalName: string;
    try {
      logicalName = projectPath(this.index.root, decoded.value).relativePath;
    } catch (error) {
      if (error instanceof HostError && error.code === 'invalid-path') {
        return unresolved('root-escape', reference, from, [], error.message);
      }
      throw error;
    }
    const matches = this.index.resources(logicalName);
    if (matches.length === 1) return resolved(matches[0]!);
    if (matches.length > 1) {
      const candidates = matches.map((match) => match.path);
      return unresolved(
        'ambiguous-resource',
        reference,
        from,
        candidates,
        `Resource name is ambiguous: ${candidates.join(', ')}`,
      );
    }
    const caseMatches = this.index.resourceCaseMatches(logicalName);
    if (caseMatches.length > 0) {
      const candidates = caseMatches.map((match) => match.path);
      return unresolved(
        'case-mismatch',
        reference,
        from,
        candidates,
        `Resource name casing differs from the reference: ${candidates.join(', ')}`,
      );
    }
    return unresolved('missing-resource', reference, from, [], `Resource does not exist: ${logicalName}`);
  }

  createAssetHook(from: string | null, reportDiagnostic: ResolutionDiagnosticReporter): AssetResolverHook {
    return Object.freeze((path: string, form: 'url' | 'resource'): string | null => {
      const outcome = form === 'url'
        ? this.resolveProjectFile(path, from, false, 'parsed')
        : this.resolveResourceReference(path, from, 'parsed');
      if (outcome.status === 'unresolved') {
        reportDiagnostic(outcome.diagnostic);
        return null;
      }
      return outcome.path;
    });
  }

  private resolveProjectFile(
    reference: string,
    from: string | null,
    requireText: boolean,
    input: 'parsed' | 'raw',
  ): ResolutionOutcome {
    const decodedReference = decodeReference(reference, from, input);
    if (decodedReference.status === 'unresolved') return decodedReference;
    const decoded = decodedReference.value;
    let normalized: ReturnType<typeof projectPath>;
    try {
      normalized = projectPath(this.index.root, projectReferencePath(decoded, from));
    } catch (error) {
      if (error instanceof HostError && error.code === 'invalid-path') {
        return unresolved('root-escape', reference, from, [], error.message);
      }
      throw error;
    }
    const file = this.index.file(normalized.relativePath);
    if (file !== null && (!requireText || file.text !== null)) return resolved(file);
    if (file === null) {
      const caseMatches = this.index.caseMatches(normalized.relativePath);
      if (caseMatches.length > 0) {
        const candidates = caseMatches.map((match) => match.path);
        return unresolved(
          'case-mismatch',
          reference,
          from,
          candidates,
          `Project path casing differs from the reference: ${candidates.join(', ')}`,
        );
      }
    }
    return unresolved(
      'missing-file',
      reference,
      from,
      [],
      `Project file does not exist: ${normalized.relativePath}`,
    );
  }

  createImportHook(entryPath: string, reportDiagnostic: ResolutionDiagnosticReporter): ImportResolverHook {
    const canonicalParents = new Map<string, Set<string>>();
    return Object.freeze((url: string, from: string | null): ResolvedText | null => {
      const canonicalParent = this.canonicalImportParent(url, from, entryPath, canonicalParents);
      if (typeof canonicalParent !== 'string') {
        reportDiagnostic(canonicalParent.diagnostic);
        return null;
      }
      const outcome = this.resolveProjectFile(url, canonicalParent, true, 'parsed');
      if (outcome.status === 'unresolved') {
        reportDiagnostic(outcome.diagnostic);
        return null;
      }
      if (outcome.text === null) return null;
      rememberCanonicalParent(canonicalParents, url, outcome.path);
      return Object.freeze({ path: outcome.path, text: outcome.text });
    });
  }

  private canonicalImportParent(
    reference: string,
    authoredFrom: string | null,
    entryPath: string,
    canonicalParents: ReadonlyMap<string, ReadonlySet<string>>,
  ): string | UnresolvedResolutionOutcome {
    if (authoredFrom === null) return entryPath;
    const mappedParents = canonicalParents.get(authoredFrom);
    if (mappedParents !== undefined) {
      const candidates = [...mappedParents].sort();
      if (candidates.length === 1) return candidates[0]!;
      if (candidates.length > 1) {
        return unresolved(
          'ambiguous-parent',
          reference,
          authoredFrom,
          candidates,
          `Authored import parent maps to multiple project files: ${candidates.join(', ')}`,
        );
      }
    }
    const exactParent = this.index.file(authoredFrom);
    if (exactParent !== null && exactParent.text !== null) return exactParent.path;
    const resolvedParent = this.resolveProjectFile(authoredFrom, entryPath, true, 'parsed');
    return resolvedParent.status === 'resolved' ? resolvedParent.path : resolvedParent;
  }
}

function rememberCanonicalParent(
  canonicalParents: Map<string, Set<string>>,
  authoredUrl: string,
  canonicalPath: string,
): void {
  const paths = canonicalParents.get(authoredUrl) ?? new Set<string>();
  paths.add(canonicalPath);
  canonicalParents.set(authoredUrl, paths);
}

function decodeReference(
  reference: string,
  from: string | null,
  input: 'parsed' | 'raw' = 'raw',
): Extract<ProjectReferenceDecodeResult, { readonly status: 'decoded' }> | UnresolvedResolutionOutcome {
  const decoded = input === 'raw'
    ? decodeProjectReference(reference)
    : decodeParsedProjectReference(reference);
  if (decoded.status === 'decoded') return decoded;
  const malformedForm = decoded.reason === 'xml-entity' ? 'XML entities' : 'percent encoding';
  return unresolved(
    'malformed-reference',
    reference,
    from,
    [],
    `Reference contains malformed ${malformedForm}: ${reference}`,
  );
}

function resolved(file: Readonly<{ readonly path: string; readonly text: string | null }>): ResolutionOutcome {
  return Object.freeze({ status: 'resolved', path: file.path, text: file.text, diagnostic: null });
}

function projectReferencePath(reference: string, from: string | null): string {
  if (reference.startsWith('project://database/')) {
    return reference.slice('project://database/'.length);
  }
  if (reference.startsWith('/Assets/')) return reference.slice(1);
  if (reference.startsWith('Assets/') || reference.startsWith('Packages/')) return reference;
  if (from !== null) {
    const separator = from.lastIndexOf('/');
    if (separator >= 0) return `${from.slice(0, separator)}/${reference}`;
  }
  return reference;
}

function unresolved(
  code: ResolutionDiagnosticCode,
  reference: string,
  from: string | null,
  candidates: readonly string[],
  message: string,
): UnresolvedResolutionOutcome {
  const diagnostic = Object.freeze({
    code,
    reference,
    from,
    candidates: Object.freeze([...candidates]),
    message,
  });
  return Object.freeze({ status: 'unresolved', path: null, text: null, diagnostic });
}
