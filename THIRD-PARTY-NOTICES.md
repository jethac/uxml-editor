# Third-Party Notices

This application is Apache-2.0 licensed. The following notices cover runtime
components redistributed in its browser and desktop build output.

## Tauri desktop host

The desktop shell uses the following pinned Tauri and Rust components:

- `@tauri-apps/api` 2.11.1 (`sha512-M2FPuYND2m+wh5hfW9ZpSdxMPdEJovPBWwoHJmwUpysTYNHaOkVFN419m/K0LIgjb/7KU2vBgsUepJWugQCvAA==`), Apache-2.0 OR MIT
- `@tauri-apps/cli` 2.11.4, Apache-2.0 OR MIT
- `tauri` 2.11.5, Apache-2.0 OR MIT
- `tauri-build` 2.6.3, Apache-2.0 OR MIT
- `tauri-plugin-dialog` 2.7.1, Apache-2.0 OR MIT
- `tauri-plugin-fs` 2.5.1 (transitive type dependency of the dialog plugin; not initialized or capability-granted), Apache-2.0 OR MIT
- `notify` 6.1.1, CC0-1.0
- `cap-std` 4.0.2, Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT
- `sha2` 0.10.9, MIT OR Apache-2.0
- `serde` 1.0.229 and `serde_json` 1.0.151, MIT OR Apache-2.0
- `windows-sys` 0.61.2 (Windows builds), MIT OR Apache-2.0

Sources: https://github.com/tauri-apps/tauri,
https://github.com/tauri-apps/plugins-workspace,
https://github.com/notify-rs/notify,
https://github.com/bytecodealliance/cap-std,
https://github.com/RustCrypto/hashes,
https://github.com/serde-rs, and https://github.com/microsoft/windows-rs.

## uxml-preview

- Package: [uxml-preview](https://www.npmjs.com/package/uxml-preview)
- Version: 0.4.0
- npm integrity: `sha512-CS26v3f85dQ5ZFbTGnoCyTtpyaD1/emDlg6/7+/G3JeGi82oghiGBxxmh5qSdJDQrzs53lKXqPhEvVc4CDQXSg==`
- Upstream tag commit: `f358e98a805d4ae5a52fc04ff6989b3053354539`
- License: Apache-2.0
- Source: https://github.com/ReuHomi/uxml-preview

Copyright 2026 Reu Homi and uxml-preview contributors. `uxml-preview` is used
under the Apache License, Version 2.0. Its license is available from the
upstream package and repository.

## yoga-layout

Vite bundles `yoga-layout` and its WebAssembly runtime through `uxml-preview`.

- Package: [yoga-layout](https://www.npmjs.com/package/yoga-layout)
- Version: 3.2.1
- npm integrity: `sha512-0LPOt3AxKqMdFBZA3HBAt/t/8vIKq7VaQYbuA8WxCgung+p9TVyKRYdpvCb80HcdTN2NkbIKbhNwKUfm3tQywQ==`
- License: MIT
- Source: https://github.com/facebook/yoga

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## CodeMirror 6

The source editor uses the following CodeMirror packages directly:

- `@codemirror/state` 6.7.1 (`sha512-9QzNDgE4EYDnAHfrTlR2lwiPciiOymLtwKK+8yHQzCc7GXhAP9xdEbEJFy2IWB1j9UGUl9BsgMmTo/ImA02T7A==`)
- `@codemirror/view` 6.43.8 (`sha512-qtItTDssZ/5GFfi94hrILu9j/VUeFPDPkhovEfmWFj2ipTxnzPB8DdHgfbb8HYTzLTYhrndKmyQxXUz/PDLenw==`)
- `@codemirror/search` 6.7.1 (`sha512-uMe5UO6PamJtSHrXhhHOzSX3ReWtiJrva6GnPMwSOrZtiExb5X5eExhr2OUZQVvdxPsKpY3Ro2mFbQadpPWmHA==`)
- `@codemirror/lang-xml` 6.1.0 (`sha512-3z0blhicHLfwi2UgkZYRPioSgVTo9PV5GP5ducFH6FaHy0IAJRg+ixj5gTR1gnT/glAIC8xv4w2VL1LoZfs+Jg==`)
- `@codemirror/lang-css` 6.3.1 (`sha512-kr5fwBGiGtmz6l0LSJIbno9QrifNMUusivHbnA1H6Dmqy4HZFte3UAICix1VuKo0lMPKQr2rqB+0BkKi/S3Ejg==`)
- `@codemirror/commands` 6.10.4 (`sha512-Ryk9y9T0FFVF0cUGhAknveAyUOl/A1qReTFi+qPKtOh2Z9F4AUBz3XOrYD4ZEgZirdugVzHvd/2/Wcwy5OliTg==`)
- `@codemirror/language` 6.12.4 (`sha512-1q4PaT+o6PbgpkJt4Q8Fv5XJxTy4FUZ4MWETtyiDw3J0Pyr9E2vqcKL+k9wcvjNTIsauxvE7OfmWj3FRPHQ76A==`)

- License: MIT
- Source: https://github.com/codemirror

Copyright (C) 2018-2021 by Marijn Haverbeke and others.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## axe-core Playwright accessibility testing

The automated accessibility test suite uses the following pinned development
dependencies. They are test tooling and are not imported by the production
application:

- `@axe-core/playwright` 4.13.0 (`sha512-6YLx+kxXu5GJceG4ozFg+33a2EMTdjYwWGloJ3sb9Kta5pp+ZNS53uxGVog5JetIY8s++P5UrtX+cri+u0VAVg==`)
- `axe-core` 4.13.0 (`sha512-UzGt8zg7Ny8djbYMhxl2zuEevVa7r2gJjYY5Lwr1xM7+XU2nd6CkIWFTVcCIbAP63vSz71NaVyyuSk9lHKcy0A==`)
- License: Mozilla Public License 2.0
- Source: https://github.com/dequelabs/axe-core-npm and
  https://github.com/dequelabs/axe-core

The complete Mozilla Public License 2.0 text is included in each installed
package's `LICENSE` file and is available at
https://www.mozilla.org/MPL/2.0/.
