import { HostError, projectPath } from '../host/HostPort';
import type { ResolvedText } from '../adapter/types';
import type { ProjectIndex } from './ProjectIndex';
import { decodeProjectReference, type ProjectReferenceDecodeResult } from './ProjectReferenceDecoder';

export type ResolutionDiagnosticCode =
  | 'ambiguous-resource'
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
    return this.resolveProjectFile(reference, from, true);
  }

  resolveAsset(reference: string, from: string | null): ResolutionOutcome {
    return this.resolveProjectFile(reference, from, false);
  }

  resolveResource(reference: string): ResolutionOutcome {
    const decoded = decodeReference(reference, null);
    if (decoded.status === 'unresolved') return decoded;
    let logicalName: string;
    try {
      logicalName = projectPath(this.index.root, decoded.value).relativePath;
    } catch (error) {
      if (error instanceof HostError && error.code === 'invalid-path') {
        return unresolved('root-escape', reference, null, [], error.message);
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
        null,
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
        null,
        candidates,
        `Resource name casing differs from the reference: ${candidates.join(', ')}`,
      );
    }
    return unresolved('missing-resource', reference, null, [], `Resource does not exist: ${logicalName}`);
  }

  createAssetHook(from: string | null, reportDiagnostic: ResolutionDiagnosticReporter): AssetResolverHook {
    return Object.freeze((path: string, form: 'url' | 'resource'): string | null => {
      const outcome = form === 'url'
        ? this.resolveAsset(path, from)
        : this.resolveResource(path);
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
  ): ResolutionOutcome {
    const decodedReference = decodeReference(reference, from);
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

  createImportHook(reportDiagnostic: ResolutionDiagnosticReporter): ImportResolverHook {
    return Object.freeze((url: string, from: string | null): ResolvedText | null => {
      const outcome = this.resolveImport(url, from);
      if (outcome.status === 'unresolved') {
        reportDiagnostic(outcome.diagnostic);
        return null;
      }
      if (outcome.text === null) return null;
      return Object.freeze({ path: outcome.path, text: outcome.text });
    });
  }
}

function decodeReference(
  reference: string,
  from: string | null,
): Extract<ProjectReferenceDecodeResult, { readonly status: 'decoded' }> | UnresolvedResolutionOutcome {
  const decoded = decodeProjectReference(reference);
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
