import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UxmlPreviewAdapter } from './UxmlPreviewAdapter';
import type { EditorNodeId } from './types';

const moduleUrl = import.meta.url;
const projectRoot = fileURLToPath(new URL('../../../', moduleUrl));
const uxml = readFileSync(join(projectRoot, 'tests/fixtures/minimal.uxml'), 'utf8');
const minimalUss = readFileSync(join(projectRoot, 'tests/fixtures/minimal.uss'), 'utf8');
const paletteUss = 'VisualElement { padding-left: 4px; }\n';

interface NodeTree {
  readonly id: EditorNodeId;
  readonly children: readonly NodeTree[];
}

function fixtureInput() {
  const resolveImport = vi.fn(() => null);

  return {
    uxmlPath: 'Assets/UI/minimal.uxml',
    uxml,
    stylesheets: new Map([
      ['Assets/UI/styles/minimal.uss', minimalUss],
      ['Assets/UI/styles/palette.uss', paletteUss],
    ]),
    resolveImport,
  };
}

function allNodes(node: NodeTree): EditorNodeId[] {
  return [node.id, ...node.children.flatMap(allNodes)];
}

function findNode(node: NodeTree & { readonly name: string }, name: string): (NodeTree & { readonly name: string }) | undefined {
  if (node.name === name) {
    return node;
  }
  for (const child of node.children) {
    const found = findNode(child as NodeTree & { readonly name: string }, name);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

const deterministicMeasureText = (text: string) => ({
  width: text.length * 8,
  height: 16,
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('UxmlPreviewAdapter', () => {
  it('round-trips untouched UXML and every stylesheet buffer byte-for-byte', () => {
    const adapter = new UxmlPreviewAdapter();
    const input = fixtureInput();

    const parsed = adapter.parseProject(input);

    expect(adapter.serializeEntry(parsed)).toEqual({
      uxml,
      stylesheets: input.stylesheets,
    });
    expect(parsed.originsBySheet).toEqual([
      'Assets/UI/styles/minimal.uss',
      'Assets/UI/styles/palette.uss',
    ]);
    expect(input.resolveImport).not.toHaveBeenCalled();
  });

  it('uses the fallback resolver with its canonical source path', () => {
    const adapter = new UxmlPreviewAdapter();
    const resolveImport = vi.fn((url: string) => url === 'external.uss'
      ? { path: 'Assets/Shared/external.uss', text: minimalUss }
      : null);
    const input = {
      ...fixtureInput(),
      uxml: uxml.replace('Assets/UI/styles/minimal.uss', 'external.uss'),
      stylesheets: new Map<string, string>(),
      resolveImport,
    };

    const parsed = adapter.parseProject(input);

    expect(parsed.originsBySheet).toEqual(['Assets/Shared/external.uss']);
    expect(resolveImport).toHaveBeenCalledWith('external.uss', null);
  });

  it('maps parse warnings to editor diagnostics with source provenance', () => {
    const adapter = new UxmlPreviewAdapter();
    const parsed = adapter.parseProject({
      ...fixtureInput(),
      uxml: uxml.replace('Assets/UI/styles/minimal.uss', 'missing.uss'),
      stylesheets: new Map<string, string>(),
    });

    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({
      origin: 'parse',
      kind: 'import-unresolved',
      source: expect.objectContaining({ path: 'Assets/UI/minimal.uxml' }),
    }));
  });

  it('renders Label and Button nodes with deterministic layout and reverse lookup', async () => {
    const adapter = new UxmlPreviewAdapter();
    const parsed = adapter.parseProject(fixtureInput());
    const container = document.createElement('div');
    document.body.append(container);

    const frame = await adapter.render(parsed, container, {
      size: { width: 640, height: 480 },
      measureText: deterministicMeasureText,
    });

    expect(frame.elements.size).toBeGreaterThanOrEqual(3);
    for (const nodeId of allNodes(parsed.root)) {
      const element = frame.elements.get(nodeId);
      if (element !== undefined) {
        expect(frame.nodeForElement(element)).toBe(nodeId);
      }
    }
    expect(container.textContent).toContain('Welcome');
    expect(container.textContent).toContain('Continue');

    frame.dispose();
    expect(() => frame.dispose()).not.toThrow();
    container.remove();
  });

  it('disposes the previous upstream render before rerendering through one adapter', async () => {
    const adapter = new UxmlPreviewAdapter();
    const parsed = adapter.parseProject(fixtureInput());
    const container = document.createElement('div');
    document.body.append(container);
    const options = { size: { width: 640, height: 480 }, measureText: deterministicMeasureText };

    const first = await adapter.render(parsed, container, options);
    const firstElement = [...first.elements.values()][0];
    const second = await adapter.render(parsed, container, options);

    expect(firstElement.isConnected).toBe(false);
    second.dispose();
    container.remove();
  });

  it('explains styles using editor-owned candidates and source spans', () => {
    const adapter = new UxmlPreviewAdapter();
    const parsed = adapter.parseProject(fixtureInput());
    const label = findNode(parsed.root, 'ui:Label');

    expect(label).toBeDefined();
    const explanation = adapter.explain(parsed, label!.id, 'color');

    expect(explanation).toEqual(expect.objectContaining({
      nodeId: label!.id,
      property: 'color',
      candidates: expect.arrayContaining([
        expect.objectContaining({
          winner: true,
          origin: expect.objectContaining({
            kind: 'rule',
            source: expect.objectContaining({ path: 'Assets/UI/styles/minimal.uss' }),
          }),
        }),
      ]),
    }));
    expect(adapter.explain(parsed, 'unknown-node' as never, 'color')).toBeNull();
  });

  it('keeps the preview engine pin, lock integrity, and source import boundary exact', () => {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8'));
    const notices = readFileSync(join(projectRoot, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    const previewImporters = sourceFiles(join(projectRoot, 'src'))
      .filter((path) => /\bfrom\s*['"]uxml-preview['"]|\bimport\s*\(\s*['"]uxml-preview['"]\s*\)/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(projectRoot, path).replaceAll('\\', '/'));

    expect(packageJson.dependencies['uxml-preview']).toBe('0.4.0');
    expect(packageLock.packages['node_modules/uxml-preview']).toMatchObject({
      version: '0.4.0',
      integrity: 'sha512-CS26v3f85dQ5ZFbTGnoCyTtpyaD1/emDlg6/7+/G3JeGi82oghiGBxxmh5qSdJDQrzs53lKXqPhEvVc4CDQXSg==',
    });
    expect(notices).toContain('f358e98a805d4ae5a52fc04ff6989b3053354539');
    expect(previewImporters).toEqual(['src/core/adapter/UxmlPreviewAdapter.ts']);
  });
});
