import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

const PROJECTS = resolve(process.cwd(), 'fixtures/projects');
const FIXTURE_PATHS = [
  'menu/Assets/UI/Menu.uxml',
  'menu/Assets/UI/Menu.uss',
  'options/Assets/UI/Options.uxml',
  'options/Assets/UI/Options.uss',
  'nested-styles/Assets/UI/Nested.uxml',
  'nested-styles/Assets/UI/base.uss',
  'nested-styles/Assets/UI/components/buttons.uss',
  'assets/Assets/UI/Assets.uxml',
  'assets/Assets/UI/Assets.uss',
  'assets/Assets/Textures/icon.png',
  'assets/Packages/com.jethac.widgets/package.json',
  'assets/Packages/com.jethac.widgets/Textures/package-icon.png',
  'unsupported/Assets/UI/Unsupported.uxml',
  'unsupported/Assets/UI/Unsupported.uss',
  'malformed/Assets/UI/Malformed.uxml',
  'malformed/Assets/UI/Malformed.uss',
] as const;

describe('Task 17A deterministic fixture corpus', () => {
  test('checks in every required fixture at its exact path', () => {
    for (const relativePath of FIXTURE_PATHS) {
      expect(existsSync(resolve(PROJECTS, relativePath)), relativePath).toBe(true);
    }
  });

  test('menu preserves exactly two authored buttons and byte-sensitive formatting', () => {
    const uxml = text('menu/Assets/UI/Menu.uxml');
    const uss = text('menu/Assets/UI/Menu.uss');

    expectOnlyCrLf(uxml);
    expectOnlyCrLf(uss);
    expect(uxml.match(/<ui:Button\b/g)).toHaveLength(2);
    expect(uxml).toContain('<!-- Task 17A menu: keep this comment byte-for-byte. -->\r\n');
    expect(uxml).toContain("<ui:UXML xmlns:ui='UnityEngine.UIElements'>");
    expect(uxml).toContain('  <Style src = "Menu.uss" />');
    expect(resolveRelativeFixture('menu/Assets/UI/Menu.uxml', 'Menu.uss')).toBe(
      resolve(PROJECTS, 'menu/Assets/UI/Menu.uss'),
    );
    expect(uxml).toContain("    <ui:Button name = 'play-button' class='menu-button primary' text=\"Play &amp; Go\" tooltip='Press &quot;Enter&quot;' />");
    expect(uxml).toContain("    <ui:Button name=\"quit-button\" class = 'menu-button' text='Quit &#x26; Save' />");
    expect(uxml).toContain('<!-- keep-between-buttons -->');
    expect(uss).toContain('/* Task 17A menu stylesheet: preserve spacing and CRLF. */\r\n');
    expect(uss).toContain('.menu-button.primary {\r\n');
  });

  test('options carries responsive row and column layout plus representative field kinds', () => {
    const uxml = text('options/Assets/UI/Options.uxml');
    const uss = text('options/Assets/UI/Options.uss');

    expect(uxml).toContain('<Style src="Options.uss" />');
    expect(resolveRelativeFixture('options/Assets/UI/Options.uxml', 'Options.uss')).toBe(
      resolve(PROJECTS, 'options/Assets/UI/Options.uss'),
    );
    expect(uxml).toContain('<ui:TextField name="profile-name" label="Profile name" value="Runner" />');
    expect(uxml).toContain('<ui:SliderInt name="volume" label="Volume" low-value="0" high-value="100" value="75" />');
    expect(uxml).toContain('<ui:Slider name="ui-scale" label="UI scale" low-value="0.75" high-value="1.5" value="1.25" />');
    expect(uxml).toContain('<ui:DropdownField name="quality" label="Quality" choices="Low,Medium,High" value="High" />');
    expect(uxml).toContain('<ui:Toggle name="fullscreen" label="Fullscreen" value="true" />');
    expect(uxml).toContain('<ui:ColorField name="accent" label="Accent" value="#35a36f" />');
    expect(uxml).toContain('<ui:ObjectField name="icon-asset" label="Icon" object-type="UnityEngine.Texture2D" value="project://database/Assets/Textures/icon.png" />');
    expect(uss).toMatch(/\.options-shell\s*\{[^}]*flex-direction:\s*column;/s);
    expect(uss).toMatch(/\.options-row\s*\{[^}]*flex-direction:\s*row;[^}]*flex-wrap:\s*wrap;/s);
    expect(uss).toMatch(/\.option-control\s*\{[^}]*min-width:\s*180px;[^}]*flex-grow:\s*1;/s);
    const names = [...uxml.matchAll(/\bname="([^"]+)"/g)].map((match) => match[1]);
    expect(names).toEqual(['profile-name', 'volume', 'ui-scale', 'quality', 'fullscreen', 'accent', 'icon-asset']);
    expect(new Set(names)).toHaveLength(names.length);
  });

  test('nested styles retain the UXML link and nested relative import', () => {
    const uxml = text('nested-styles/Assets/UI/Nested.uxml');
    const base = text('nested-styles/Assets/UI/base.uss');
    const buttons = text('nested-styles/Assets/UI/components/buttons.uss');

    const link = 'base.uss';
    expect(uxml).toContain(`<Style src="${link}" />`);
    expect(resolveRelativeFixture('nested-styles/Assets/UI/Nested.uxml', link)).toBe(
      resolve(PROJECTS, 'nested-styles/Assets/UI/base.uss'),
    );
    expect(uxml).toContain('<ui:Button name="nested-action" class="nested-action" text="Nested action" />');
    const importPath = './components/buttons.uss';
    expect(base).toContain(`@import url("${importPath}");`);
    expect(resolveRelativeFixture('nested-styles/Assets/UI/base.uss', importPath)).toBe(
      resolve(PROJECTS, 'nested-styles/Assets/UI/components/buttons.uss'),
    );
    expect(base).toContain('.nested-shell {');
    expect(base).toMatch(/\.nested-action\s*\{[^}]*color:\s*#16324f;[^}]*padding-left:\s*12px;/s);
    expect(buttons).toContain('.nested-action {');
    expect(buttons).toContain('width: 160px;');
    expect(buttons).toContain('color: #fef3c7;');
    expect(buttons).toContain('background-color: #245f9e;');
  });

  test('assets covers project, relative, and package references with package metadata', () => {
    const uxml = text('assets/Assets/UI/Assets.uxml');
    const uss = text('assets/Assets/UI/Assets.uss');
    const packageJson = JSON.parse(text('assets/Packages/com.jethac.widgets/package.json')) as Record<string, unknown>;

    const projectReference = 'project://database/Assets/Textures/icon.png';
    const relativeReference = '../Textures/icon.png';
    const packageReference = 'Packages/com.jethac.widgets/Textures/package-icon.png';

    expect(uxml.match(/<ui:Image\b/g)).toHaveLength(3);
    expect(uxml).toContain('<Style src="Assets.uss" />');
    expect(resolveRelativeFixture('assets/Assets/UI/Assets.uxml', 'Assets.uss')).toBe(
      resolve(PROJECTS, 'assets/Assets/UI/Assets.uss'),
    );
    expect(uxml).toContain(`image="${projectReference}"`);
    expect(uxml).toContain(`image="${relativeReference}"`);
    expect(uxml).toContain(`image="${packageReference}"`);
    expect(uss).toContain(`url("${projectReference}")`);
    expect(uss).toContain(`url("${relativeReference}")`);
    expect(uss).toContain(`url("${packageReference}")`);
    expect(resolveProjectReference('assets', projectReference)).toBe(resolve(PROJECTS, 'assets/Assets/Textures/icon.png'));
    expect(resolveRelativeFixture('assets/Assets/UI/Assets.uxml', relativeReference)).toBe(
      resolve(PROJECTS, 'assets/Assets/Textures/icon.png'),
    );
    expect(resolvePackageReference('assets', packageReference)).toBe(
      resolve(PROJECTS, 'assets/Packages/com.jethac.widgets/Textures/package-icon.png'),
    );
    expect(packageJson).toEqual({
      name: 'com.jethac.widgets',
      version: '1.0.0',
      displayName: 'Task 17A Fixture Widgets',
      description: 'Deterministic package metadata for UXML Editor browser workflows.',
      unity: '2022.3',
      type: 'library',
    });
  });

  test('unsupported preserves an unknown control, property, selector state, and children', () => {
    const uxml = text('unsupported/Assets/UI/Unsupported.uxml');
    const uss = text('unsupported/Assets/UI/Unsupported.uss');
    const unknown = uxml.slice(
      uxml.indexOf('<acme:UnknownPanel'),
      uxml.indexOf('</acme:UnknownPanel>') + '</acme:UnknownPanel>'.length,
    );

    expect(unknown).toContain('mystery-mode="orbital"');
    expect(unknown).toContain('<ui:Label name="preserved-label" class="unsupported-child" text="Preserved child" />');
    expect(unknown).toContain('<ui:Button name="preserved-button" text="Still editable" />');
    expect(uss).toContain('.unknown-panel:focus-visible > .unsupported-child {');
    expect(uss).toContain('-unity-unsupported-glow: 7px;');
    expect(uss).toContain('.unknown-panel:visited {');
  });

  test('malformed contains repairable UXML and USS spans plus formatting edges', () => {
    const uxml = text('malformed/Assets/UI/Malformed.uxml');
    const uss = text('malformed/Assets/UI/Malformed.uss');

    expect(uxml).toMatch(/  <!-- preserved prefix: tabs and spacing stay untouched -->\r?\n/);
    expect(uxml).toMatch(/\t<ui:Label name='before-repair' text="Before repair" \/>\r?\n/);
    expect(uxml).toMatch(/    <ui:Button name="broken-button" text="Repair me"\r?\n/);
    expect(uxml).toMatch(/    <ui:Label name="after-repair" text='After repair' \/>\r?\n/);
    expect(uss).toMatch(/\.recover-root\{\r?\n\tpadding-left : 12px;/);
    expect(uss).toContain('color: #12zz34;');
    expect(uss).toContain('background-color: rgb(10, 20, );');
    expect(uss).toContain('.trailing-edge { width: calc(100% - ); } /* keep */');
  });

  test('both checked-in PNGs decode to fixed nonblank pixels', () => {
    const asset = decodePng(bytes('assets/Assets/Textures/icon.png'));
    const packageAsset = decodePng(bytes('assets/Packages/com.jethac.widgets/Textures/package-icon.png'));

    expect({ width: asset.width, height: asset.height }).toEqual({ width: 8, height: 8 });
    expect(pixel(asset, 0, 0)).toEqual([30, 132, 73, 255]);
    expect(pixel(asset, 1, 0)).toEqual([250, 204, 21, 255]);
    expect(uniqueColors(asset)).toBeGreaterThan(1);
    expect(opaquePixelCount(asset)).toBe(64);

    expect({ width: packageAsset.width, height: packageAsset.height }).toEqual({ width: 10, height: 6 });
    expect(pixel(packageAsset, 0, 0)).toEqual([35, 93, 160, 255]);
    expect(pixel(packageAsset, 9, 5)).toEqual([236, 72, 153, 255]);
    expect(uniqueColors(packageAsset)).toBeGreaterThan(1);
    expect(opaquePixelCount(packageAsset)).toBe(60);
  });
});

function bytes(relativePath: string): Buffer {
  return readFileSync(resolve(PROJECTS, relativePath));
}

function text(relativePath: string): string {
  return bytes(relativePath).toString('utf8');
}

function resolveRelativeFixture(source: string, reference: string): string {
  const target = resolve(dirname(resolve(PROJECTS, source)), reference);
  expect(existsSync(target), `${source} -> ${reference}`).toBe(true);
  return target;
}

function resolveProjectReference(project: string, reference: string): string {
  const prefix = 'project://database/';
  expect(reference.startsWith(prefix)).toBe(true);
  const target = resolve(PROJECTS, project, reference.slice(prefix.length));
  expect(existsSync(target), reference).toBe(true);
  return target;
}

function resolvePackageReference(project: string, reference: string): string {
  const target = resolve(PROJECTS, project, reference);
  expect(existsSync(target), reference).toBe(true);
  return target;
}

function expectOnlyCrLf(value: string): void {
  expect(value.endsWith('\r\n')).toBe(true);
  expect(value).toContain('\r\n');
  expect(value.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
}

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

function decodePng(input: Buffer): DecodedPng {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!input.subarray(0, signature.length).equals(signature)) throw new Error('Invalid PNG signature.');
  let cursor = signature.length;
  let width = 0;
  let height = 0;
  const compressed: Buffer[] = [];
  let ended = false;
  while (cursor < input.length) {
    const length = input.readUInt32BE(cursor);
    const type = input.toString('ascii', cursor + 4, cursor + 8);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > input.length) throw new Error(`Truncated PNG ${type} chunk.`);
    const data = input.subarray(dataStart, dataEnd);
    const expectedCrc = input.readUInt32BE(dataEnd);
    const actualCrc = crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]));
    if (actualCrc !== expectedCrc) throw new Error(`Invalid PNG ${type} CRC.`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error('Fixture PNGs must be non-interlaced 8-bit RGBA images.');
      }
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      ended = true;
      cursor = dataEnd + 4;
      break;
    }
    cursor = dataEnd + 4;
  }
  if (!ended || cursor !== input.length || width <= 0 || height <= 0 || compressed.length === 0) {
    throw new Error('Incomplete PNG stream.');
  }
  const inflated = inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  if (inflated.length !== (stride + 1) * height) throw new Error('Unexpected PNG scanline length.');
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const encoded = inflated[y * (stride + 1) + x + 1];
      const output = y * stride + x;
      const left = x >= 4 ? pixels[output - 4] : 0;
      const above = y > 0 ? pixels[output - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[output - stride - 4] : 0;
      pixels[output] = (encoded + filterPrediction(filter, left, above, upperLeft)) & 0xff;
    }
  }
  return Object.freeze({ width, height, pixels });
}

function filterPrediction(filter: number, left: number, above: number, upperLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return above;
  if (filter === 3) return Math.floor((left + above) / 2);
  if (filter === 4) return paeth(left, above, upperLeft);
  throw new Error(`Unsupported PNG filter ${filter}.`);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pixel(image: DecodedPng, x: number, y: number): readonly number[] {
  const offset = (y * image.width + x) * 4;
  return [...image.pixels.slice(offset, offset + 4)];
}

function uniqueColors(image: DecodedPng): number {
  const colors = new Set<string>();
  for (let offset = 0; offset < image.pixels.length; offset += 4) {
    colors.add([...image.pixels.slice(offset, offset + 4)].join(','));
  }
  return colors.size;
}

function opaquePixelCount(image: DecodedPng): number {
  let count = 0;
  for (let offset = 3; offset < image.pixels.length; offset += 4) {
    if (image.pixels[offset] === 255) count += 1;
  }
  return count;
}
