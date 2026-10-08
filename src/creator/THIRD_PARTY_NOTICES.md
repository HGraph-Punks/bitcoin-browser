# Third-party notices

The visual palette and interface research derive from [Bitcoin Browser](https://github.com/HGraph-Punks/bitcoin-browser), inspected at commit `c87056ac13a99cbb7d3f1edd92e995222d41b367`. Its notice is retained below. No browser wallet implementation or logo asset was copied into this application.

```text
MIT License

Copyright (c) 2026 Satoshi Browser contributors

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
```

Installed dependencies retain their own licenses in their npm packages. Every build generates `dist/licenses/THIRD_PARTY_NOTICES.txt` and `inventory.json` from the packages actually bundled by esbuild, including complete available license/notice texts and their hashes. Packaging copies those files into the application alongside Electron's runtime license and Chromium notice file; Help opens the application notices. The notice generator rejects a bundled package with no license text. Build-time packager dependencies are not shipped as application runtime code. The Ord executable is selected locally rather than redistributed. On-chain library runtime and license qualification remains tracked in the catalog; those scripts are fetched by exact inscription ID and are not included in the application package.

Exact on-chain library notice texts, URLs and hashes are retained in [license-notices.json](src/catalog/license-notices.json) and emitted into generated website credits. Three.js r178 uses MIT; Tone 15.0.4 uses MIT with retained MIT/0BSD runtime dependency notices. The p5 LGPL-2.1 corresponding-source/distribution review and Phaser embedded-code inventory remain open. See [library qualification](docs/LIBRARY_QUALIFICATION.md) for scope and primary sources. Runtime scripts themselves remain fetched by their pinned inscription IDs rather than bundled into the application.

## diff 9.0.0 (jsdiff)

The desktop and MCP source-comparison services use [jsdiff](https://github.com/kpdecker/jsdiff). It is not embedded in generated websites. The exact installed license follows:

```text
BSD 3-Clause License

Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
