import { describe, expect, it } from 'vitest';
import { MemoryHost } from '../host/MemoryHost';
import { projectPath } from '../host/HostPort';
import { ProjectIndex } from './ProjectIndex';

describe('ProjectIndex', () => {
  it('creates a fresh immutable snapshot after external package rewrites and deletion', async () => {
    const host = new MemoryHost({
      projects: [{
        id: 'project',
        name: 'Project',
        files: {
          'Packages/com.example.ui/theme.uss': 'Button { color: red; }',
          'Packages/com.example.ui/icon.png': 'not read as text',
        },
      }],
    });
    const root = (await host.chooseProject())!;
    const themePath = projectPath(root, 'Packages/com.example.ui/theme.uss');

    const first = await ProjectIndex.scan(host, root);
    const firstTheme = first.file('Packages/com.example.ui/theme.uss');
    await host.externalWrite(themePath, 'Button { color: blue; }');
    const second = await ProjectIndex.scan(host, root);
    await host.externalDelete(themePath);
    const third = await ProjectIndex.scan(host, root);

    expect(firstTheme).toMatchObject({
      path: 'Packages/com.example.ui/theme.uss',
      text: 'Button { color: red; }',
    });
    expect(second.file('Packages/com.example.ui/theme.uss')).toMatchObject({
      path: 'Packages/com.example.ui/theme.uss',
      text: 'Button { color: blue; }',
    });
    expect(second.file('Packages/com.example.ui/theme.uss')?.revision).not.toBe(firstTheme?.revision);
    expect(third.file('Packages/com.example.ui/theme.uss')).toBeNull();
    expect(second.file('Packages/com.example.ui/icon.png')).toMatchObject({ text: null, revision: null });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.files)).toBe(true);
    expect(first.files.every(Object.isFrozen)).toBe(true);
  });
});
