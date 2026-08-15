import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryHost } from '../host/MemoryHost';
import { PathResolver } from './PathResolver';
import { ProjectIndex } from './ProjectIndex';

describe('PathResolver', () => {
  let resolver: PathResolver;

  beforeAll(async () => {
    const host = new MemoryHost({
      projects: [{
        id: 'resolution',
        name: 'Resolution',
        files: {
          'Assets/UI/base.uss': 'VisualElement {}',
          'Packages/com.example.ui/theme.uss': 'VisualElement {}',
        },
      }],
    });
    const root = (await host.chooseProject())!;
    resolver = new PathResolver(await ProjectIndex.scan(host, root));
  });

  it.each([
    ['project://database/Assets/UI/base.uss', 'Assets/UI/base.uss'],
    ['/Assets/UI/base.uss', 'Assets/UI/base.uss'],
    ['Packages/com.example.ui/theme.uss', 'Packages/com.example.ui/theme.uss'],
  ])('resolves %s to %s', (reference, expected) => {
    expect(resolver.resolveImport(reference, null)?.path).toBe(expected);
  });

  it('resolves a relative import against its immediate parent file', async () => {
    const relativeResolver = await resolverFor({
      'Assets/UI/base.uss': 'VisualElement {}',
      'Assets/UI/nested/theme.uss': '@import url("../base.uss");',
    });

    const result = relativeResolver.resolveImport('../base.uss', 'Assets/UI/nested/theme.uss');

    expect(result).toMatchObject({ status: 'resolved', path: 'Assets/UI/base.uss' });
  });

  it('resolves cyclic imports without poisoning later hook calls', async () => {
    const cycleResolver = await resolverFor({
      'Assets/Cycle/a.uss': '@import url("b.uss");',
      'Assets/Cycle/b.uss': '@import url("a.uss");',
      'Assets/Cycle/c.uss': 'VisualElement {}',
    });
    const diagnostics: unknown[] = [];
    const resolveImport = cycleResolver.createImportHook((diagnostic) => diagnostics.push(diagnostic));

    expect(resolveImport('b.uss', 'Assets/Cycle/a.uss')?.path).toBe('Assets/Cycle/b.uss');
    expect(resolveImport('a.uss', 'Assets/Cycle/b.uss')?.path).toBe('Assets/Cycle/a.uss');
    expect(resolveImport('b.uss', 'Assets/Cycle/a.uss')?.path).toBe('Assets/Cycle/b.uss');
    expect(resolveImport('c.uss', 'Assets/Cycle/a.uss')?.path).toBe('Assets/Cycle/c.uss');
    expect(diagnostics).toEqual([]);
  });

  it('does not reuse the resolution of the same spelling from a different parent', async () => {
    const parentResolver = await resolverFor({
      'Assets/A/entry.uss': '@import url("shared.uss");',
      'Assets/A/shared.uss': 'A {}',
      'Assets/B/entry.uss': '@import url("shared.uss");',
    });
    const diagnostics: unknown[] = [];
    const resolveImport = parentResolver.createImportHook((diagnostic) => diagnostics.push(diagnostic));

    expect(resolveImport('shared.uss', 'Assets/A/entry.uss')?.path).toBe('Assets/A/shared.uss');
    expect(resolveImport('shared.uss', 'Assets/B/entry.uss')).toBeNull();
    expect(diagnostics).toMatchObject([{ code: 'missing-file', from: 'Assets/B/entry.uss' }]);
  });

  it('returns a frozen diagnostic outcome for a missing import', async () => {
    const missingResolver = await resolverFor({
      'Assets/UI/screen.uxml': '<ui:UXML />',
    });

    const result = missingResolver.resolveImport('missing.uss', 'Assets/UI/screen.uxml');

    expect(result).toMatchObject({
      status: 'unresolved',
      path: null,
      text: null,
      diagnostic: {
        code: 'missing-file',
        reference: 'missing.uss',
        from: 'Assets/UI/screen.uxml',
        candidates: [],
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostic)).toBe(true);
    expect(Object.isFrozen(result.diagnostic?.candidates)).toBe(true);
  });

  it('decodes percent-encoded import path segments before lookup', async () => {
    const encodedResolver = await resolverFor({
      'Assets/UI/screen.uxml': '<ui:UXML />',
      'Assets/UI/base theme.uss': 'VisualElement {}',
    });

    const result = encodedResolver.resolveImport('base%20theme.uss', 'Assets/UI/screen.uxml');

    expect(result).toMatchObject({ status: 'resolved', path: 'Assets/UI/base theme.uss' });
  });

  it('diagnoses malformed percent encoding without throwing', async () => {
    const malformedResolver = await resolverFor({
      'Assets/UI/screen.uxml': '<ui:UXML />',
    });

    const result = malformedResolver.resolveImport('bad%2.uss', 'Assets/UI/screen.uxml');

    expect(result).toMatchObject({
      status: 'unresolved',
      diagnostic: { code: 'malformed-reference', reference: 'bad%2.uss' },
    });
  });

  it('decodes XML entities in import paths before lookup', async () => {
    const entityResolver = await resolverFor({
      'Assets/UI/screen.uxml': '<ui:UXML />',
      'Assets/UI/base&theme.uss': 'VisualElement {}',
    });

    const result = entityResolver.resolveImport('base&amp;theme.uss', 'Assets/UI/screen.uxml');

    expect(result).toMatchObject({ status: 'resolved', path: 'Assets/UI/base&theme.uss' });
  });

  it('diagnoses malformed XML entities without throwing', async () => {
    const malformedResolver = await resolverFor({
      'Assets/UI/screen.uxml': '<ui:UXML />',
    });

    const result = malformedResolver.resolveImport('base&unknown;theme.uss', 'Assets/UI/screen.uxml');

    expect(result).toMatchObject({
      status: 'unresolved',
      diagnostic: { code: 'malformed-reference', reference: 'base&unknown;theme.uss' },
    });
  });

  it('diagnoses a case-only path difference without selecting it', async () => {
    const caseResolver = await resolverFor({
      'Assets/UI/screen.uxml': '<ui:UXML />',
      'Assets/UI/Base.uss': 'VisualElement {}',
    });

    const result = caseResolver.resolveImport('base.uss', 'Assets/UI/screen.uxml');

    expect(result).toMatchObject({
      status: 'unresolved',
      path: null,
      diagnostic: {
        code: 'case-mismatch',
        candidates: ['Assets/UI/Base.uss'],
      },
    });
  });

  it('diagnoses a project-root escape after XML and percent decoding', async () => {
    const traversalResolver = await resolverFor({
      'Assets/UI/screen.uxml': '<ui:UXML />',
    });

    const result = traversalResolver.resolveImport(
      '..&#47;..%2F..%2Foutside.uss',
      'Assets/UI/screen.uxml',
    );

    expect(result).toMatchObject({
      status: 'unresolved',
      diagnostic: { code: 'root-escape', reference: '..&#47;..%2F..%2Foutside.uss' },
    });
  });

  it('keeps url project paths distinct from extensionless resource names', async () => {
    const assetResolver = await resolverFor({
      'Assets/UI/screen.uxml': '<ui:UXML />',
      'Assets/UI/icon.png': 'relative icon',
      'Assets/Resources/UI/icon.png': 'resource icon',
    });
    const diagnostics: unknown[] = [];
    const resolveAsset = assetResolver.createAssetHook(
      'Assets/UI/screen.uxml',
      (diagnostic) => diagnostics.push(diagnostic),
    );

    expect(resolveAsset('icon.png', 'url')).toBe('Assets/UI/icon.png');
    expect(resolveAsset('UI/icon', 'resource')).toBe('Assets/Resources/UI/icon.png');
    expect(resolveAsset('UI/icon', 'url')).toBeNull();
    expect(diagnostics).toMatchObject([{ code: 'missing-file', reference: 'UI/icon' }]);
  });

  it('diagnoses duplicate Resources logical names instead of choosing by sort order', async () => {
    const duplicateResolver = await resolverFor({
      'Assets/A/Resources/UI/icon.png': 'first',
      'Assets/B/Resources/UI/icon.jpg': 'second',
    });

    const result = duplicateResolver.resolveResource('UI/icon');

    expect(result).toMatchObject({
      status: 'unresolved',
      path: null,
      diagnostic: {
        code: 'ambiguous-resource',
        candidates: [
          'Assets/A/Resources/UI/icon.png',
          'Assets/B/Resources/UI/icon.jpg',
        ],
      },
    });
  });
});

async function resolverFor(files: Readonly<Record<string, string>>): Promise<PathResolver> {
  const host = new MemoryHost({
    projects: [{ id: 'test-project', name: 'Test Project', files }],
  });
  const root = (await host.chooseProject())!;
  return new PathResolver(await ProjectIndex.scan(host, root));
}
