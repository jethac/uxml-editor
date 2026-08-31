import { fileURLToPath } from 'node:url';

/**
 * Resolves the `uxml-preview` specifier to the vendored engine source, so the
 * adapter keeps importing the package name it would import from npm.
 */
export function previewEngineAlias(): Record<string, string> {
  const root = fileURLToPath(new URL('./src/', import.meta.url));
  return {
    'uxml-preview/unity-project': `${root}unity-project/index.ts`,
    'uxml-preview': `${root}index.ts`,
  };
}
