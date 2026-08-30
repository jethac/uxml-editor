// @vitest-environment node

import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import tauriConfig from '../../src-tauri/tauri.conf.json';
import viteConfig from '../../vite.config';

type Csp = Record<string, string[]>;

const productionCsp: Csp = {
  'base-uri': ["'none'"],
  'connect-src': ["'self'", 'ipc:', 'http://ipc.localhost'],
  'default-src': ["'self'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
  'object-src': ["'none'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
};

const developmentCsp: Csp = {
  ...productionCsp,
  'connect-src': [
    "'self'",
    'ipc:',
    'http://ipc.localhost',
    'ws://localhost:1420',
  ],
};

describe('application foundation configuration', () => {
  it('reserves the Tauri development port in Vite', () => {
    expect(viteConfig.server).toMatchObject({ port: 1420, strictPort: true });
    expect(tauriConfig.build.devUrl).toBe('http://localhost:1420');
  });

  it('declares the supported Node 24 LTS toolchain range', () => {
    const engines = (packageJson as { engines?: { node?: string } }).engines;
    expect(engines?.node).toBe('>=24.15.0 <25');
  });

  it('uses explicit least-privilege production and development policies', () => {
    const security = tauriConfig.app.security as unknown as {
      csp: Csp | null;
      devCsp?: Csp | null;
    };

    expect(security.csp).toEqual(productionCsp);
    expect(security.devCsp).toEqual(developmentCsp);
  });
});
