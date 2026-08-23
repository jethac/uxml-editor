import type { MemoryProjectInput } from '../../../src/core/host/MemoryHost';
import assetsUss from '../../../fixtures/projects/assets/Assets/UI/Assets.uss?raw';
import assetsUxml from '../../../fixtures/projects/assets/Assets/UI/Assets.uxml?raw';
import assetsIconUrl from '../../../fixtures/projects/assets/Assets/Textures/icon.png?url';
import assetsPackageJson from '../../../fixtures/projects/assets/Packages/com.jethac.widgets/package.json?raw';
import assetsPackageIconUrl from '../../../fixtures/projects/assets/Packages/com.jethac.widgets/Textures/package-icon.png?url';
import malformedUss from '../../../fixtures/projects/malformed/Assets/UI/Malformed.uss?raw';
import malformedUxml from '../../../fixtures/projects/malformed/Assets/UI/Malformed.uxml?raw';
import menuUss from '../../../fixtures/projects/menu/Assets/UI/Menu.uss?raw';
import menuUxml from '../../../fixtures/projects/menu/Assets/UI/Menu.uxml?raw';
import nestedBaseUss from '../../../fixtures/projects/nested-styles/Assets/UI/base.uss?raw';
import nestedButtonsUss from '../../../fixtures/projects/nested-styles/Assets/UI/components/buttons.uss?raw';
import nestedUxml from '../../../fixtures/projects/nested-styles/Assets/UI/Nested.uxml?raw';
import optionsUss from '../../../fixtures/projects/options/Assets/UI/Options.uss?raw';
import optionsUxml from '../../../fixtures/projects/options/Assets/UI/Options.uxml?raw';
import optionsIconUrl from '../../../fixtures/projects/options/Assets/Textures/icon.png?url';
import resolutionIconUrl from '../../../fixtures/projects/resolution/Assets/Resources/UI/icon.png?url';
import resolutionBaseUss from '../../../fixtures/projects/resolution/Assets/UI/base.uss?raw';
import resolutionNestedThemeUss from '../../../fixtures/projects/resolution/Assets/UI/nested/theme.uss?raw';
import resolutionUxml from '../../../fixtures/projects/resolution/Assets/UI/screen.uxml?raw';
import resolutionPackageThemeUss from '../../../fixtures/projects/resolution/Packages/com.example.ui/theme.uss?raw';
import unsupportedUss from '../../../fixtures/projects/unsupported/Assets/UI/Unsupported.uss?raw';
import unsupportedUxml from '../../../fixtures/projects/unsupported/Assets/UI/Unsupported.uxml?raw';

export type EditorFixtureProjectKey =
  | 'menu'
  | 'options'
  | 'nested-styles'
  | 'assets'
  | 'unsupported'
  | 'malformed'
  | 'resolution'
  | 'blank'
  | 'collision';

export const EDITOR_ASSET_URLS = Object.freeze({
  'options/Assets/Textures/icon.png': optionsIconUrl,
  'assets/Assets/Textures/icon.png': assetsIconUrl,
  'assets/Packages/com.jethac.widgets/Textures/package-icon.png': assetsPackageIconUrl,
  'resolution/Assets/Resources/UI/icon.png': resolutionIconUrl,
});

const BINARY_PLACEHOLDERS = Object.freeze({
  optionsIcon: `fixture-binary:${EDITOR_ASSET_URLS['options/Assets/Textures/icon.png']}`,
  assetsIcon: `fixture-binary:${EDITOR_ASSET_URLS['assets/Assets/Textures/icon.png']}`,
  assetsPackageIcon: `fixture-binary:${EDITOR_ASSET_URLS['assets/Packages/com.jethac.widgets/Textures/package-icon.png']}`,
  resolutionIcon: `fixture-binary:${EDITOR_ASSET_URLS['resolution/Assets/Resources/UI/icon.png']}`,
});

const SOURCE_PROJECTS: Readonly<Record<Exclude<EditorFixtureProjectKey, 'blank' | 'collision'>, MemoryProjectInput>> = Object.freeze({
  menu: project('fixture:menu', 'Menu Fixture', {
    'Assets/UI/Menu.uxml': menuUxml,
    'Assets/UI/Menu.uss': menuUss,
  }),
  options: project('fixture:options', 'Options Fixture', {
    'Assets/UI/Options.uxml': optionsUxml,
    'Assets/UI/Options.uss': optionsUss,
    'Assets/Textures/icon.png': BINARY_PLACEHOLDERS.optionsIcon,
  }),
  'nested-styles': project('fixture:nested-styles', 'Nested Styles Fixture', {
    'Assets/UI/Nested.uxml': nestedUxml,
    'Assets/UI/base.uss': nestedBaseUss,
    'Assets/UI/components/buttons.uss': nestedButtonsUss,
  }),
  assets: project('fixture:assets', 'Assets Fixture', {
    'Assets/UI/Assets.uxml': assetsUxml,
    'Assets/UI/Assets.uss': assetsUss,
    'Assets/Textures/icon.png': BINARY_PLACEHOLDERS.assetsIcon,
    'Packages/com.jethac.widgets/package.json': assetsPackageJson,
    'Packages/com.jethac.widgets/Textures/package-icon.png': BINARY_PLACEHOLDERS.assetsPackageIcon,
  }),
  unsupported: project('fixture:unsupported', 'Unsupported Fixture', {
    'Assets/UI/Unsupported.uxml': unsupportedUxml,
    'Assets/UI/Unsupported.uss': unsupportedUss,
  }),
  malformed: project('fixture:malformed', 'Malformed Fixture', {
    'Assets/UI/Malformed.uxml': malformedUxml,
    'Assets/UI/Malformed.uss': malformedUss,
  }),
  resolution: project('fixture:resolution', 'Resolution Fixture', {
    'Assets/UI/screen.uxml': resolutionUxml,
    'Assets/UI/base.uss': resolutionBaseUss,
    'Assets/UI/nested/theme.uss': resolutionNestedThemeUss,
    'Assets/Resources/UI/icon.png': BINARY_PLACEHOLDERS.resolutionIcon,
    'Packages/com.example.ui/theme.uss': resolutionPackageThemeUss,
  }),
});

const DESTINATIONS: Readonly<Record<'blank' | 'collision', MemoryProjectInput>> = Object.freeze({
  blank: project('destination:blank', 'Blank Destination', {}),
  collision: project('destination:collision', 'Collision Destination', {
    'Assets/UI/Menu.uxml': menuUxml.replace('text="Main Menu"', 'text="Collision Menu"'),
    'Assets/UI/Menu.uss': menuUss.replace('#18794e', '#8b1e3f'),
  }),
});

export function editorFixtureProjects(source: Exclude<EditorFixtureProjectKey, 'blank' | 'collision'> = 'menu'):
readonly MemoryProjectInput[] {
  const sourceProject = SOURCE_PROJECTS[source];
  return Object.freeze([
    sourceProject,
    ...Object.entries(SOURCE_PROJECTS)
      .filter(([key]) => key !== source)
      .map(([, value]) => value),
    DESTINATIONS.blank,
    DESTINATIONS.collision,
  ]);
}

export function editorFixtureProject(key: EditorFixtureProjectKey): MemoryProjectInput {
  return key === 'blank' || key === 'collision' ? DESTINATIONS[key] : SOURCE_PROJECTS[key];
}

function project(id: string, name: string, files: Readonly<Record<string, string>>): MemoryProjectInput {
  return Object.freeze({ id, name, files: Object.freeze({ ...files }) });
}
