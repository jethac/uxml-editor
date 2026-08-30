#!/usr/bin/env node
// Fails when a shipped npm dependency carries a license outside the recorded
// permissive allowlist, or carries no license at all.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
]);

// Expressions are accepted when at least one operand is allowed, which matches
// how dual-licensed packages are redistributed in THIRD-PARTY-NOTICES.md.
function isAllowed(expression) {
  return expression
    .replaceAll(/[()]/g, ' ')
    .split(/\s+OR\s+/i)
    .some((alternative) =>
      alternative
        .split(/\s+(?:AND|WITH)\s+/i)
        .map((term) => term.trim())
        .filter((term) => term.length > 0)
        .every((term) => ALLOWED_LICENSES.has(term)),
    );
}

function licenseOf(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (typeof manifest.license?.type === 'string') return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses.map((entry) => entry.type).filter(Boolean);
    if (types.length > 0) return types.join(' OR ');
  }
  return null;
}

function productionPackagePaths() {
  const stdout = execFileSync('npm', ['ls', '--all', '--omit=dev', '--parseable'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('node_modules'));
}

const violations = [];
for (const packagePath of productionPackagePaths()) {
  const manifestPath = join(packagePath, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    violations.push(`${relative(repositoryRoot, manifestPath)}: unreadable (${error.message})`);
    continue;
  }
  const license = licenseOf(manifest);
  const name = `${manifest.name ?? relative(repositoryRoot, packagePath)}@${manifest.version ?? 'unknown'}`;
  if (license === null) {
    violations.push(`${name}: no license field`);
  } else if (!isAllowed(license)) {
    violations.push(`${name}: disallowed license "${license}"`);
  }
}

if (violations.length > 0) {
  console.error('Disallowed or missing dependency licenses:');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log('All shipped npm dependencies carry an allowlisted license.');
