# Bitcoin Browser Start experience

Version **0.2.0-rc.7** adds a native Browse homepage with a Bitcoin introduction and immediately usable search. This is a signed local candidate, with public notarization and mainnet qualification still pending.

## Experience

Gold particles spiral into the bundled globe-and-Bitcoin mark over roughly 3.3 seconds, then breathe gently among sparse stars and an orbit. Pointer movement subtly interacts with the scene. The introduction does not block any action.

The search accepts the existing native identifiers and saved-item search. Three examples focus and prefill the field; they do not issue a lookup until Search or Enter. Explore inscriptions, Explore Runes, Create on Bitcoin and Ask Bitcoin have full-card click targets and use the existing native navigation and mode controls. Create remains its own application mode. Returning users see their recent places and bookmarks before discovery cards.

Narrow layouts put search ahead of the decorative scene. Keyboard order reaches search before animation controls. Light and dark themes retain a cinematic dark hero with readable controls. Native disclosures preserve access to lookup options, tools and source status.

## Motion, resources and privacy

Pause freezes both the frame count and introduction clock. Resume continues; Replay starts assembly again. Reduced motion uses the real static logo and releases WebGL. Missing WebGL, shader failure and context loss use the same static fallback. Animation suspends when hidden or offscreen; leaving Home cancels animation, removes listeners/observers and deletes GPU resources. Passive source/cache updates preserve typed text, focus, disclosure state and the running scene.

The scene uses raw WebGL, no new dependency and no external assets. Logo sampling excludes the mark’s orange background. Geometry is deterministic and capped at 2,300 logo points plus 620 stars/orbit points. Drawing is capped at 30 fps; pixel ratio and backing-buffer dimensions are bounded. No wallet is needed for Home.

## Verification

The native harness uses disposable fresh and returning profiles with no configured network data provider. It exercises real GPU shader assembly, GL errors, pause/resume/replay, offscreen suspension, live reduced-motion changes, navigation cleanup, the 24-starter Create mode, theme/layout changes, actual context loss and unavailable-WebGL fallback. Tests use the real bundled logo.

The full Browser suite passes **2,263/2,263**, retained Creator tests **54/54**, and TypeScript/static/security checks pass. See [the source-check receipt](evidence/home-source-checks.json).

[Source-native receipt](evidence/home-native.json) records the checked version and local screenshots. The [exact signed-package receipt](evidence/home-packaged.json) independently passes all 11 checks against the MoonScape Developer ID app, with no renderer errors. The live scene contains 2,257 particles. The [package integrity receipt](evidence/creator-package-integrity.json) verifies the source/payload inventory, signature, hardened runtime and seven release fuses. The [RC7 native Creator receipt](evidence/creator-packaged.json) also passes the retained 24 starters, native protocol editors, mode switching, mandatory library warning, 51 MCP tools, nine interactive library experiences and JSZip generation.

The signed RC7 archive SHA-256 is `f5057a1f26010d2fe2649568df6045b98511c44e4ff5a615593d399c813efd22`.

Inspected package screenshots: [dark homepage](evidence/home-ui/home-desktop-rc7.png), [light theme](evidence/home-ui/home-light-rc7.png), [narrow layout](evidence/home-ui/home-small-rc7.png), [reduced motion](evidence/home-ui/home-reduced-motion-rc7.png), [discovery cards](evidence/home-ui/home-discovery-rc7.png) and [returning users](evidence/home-ui/home-returning-rc7.png).

UI qualification does not claim wallet or transaction execution. Existing RC6 inscription receipts remain documented in [the Create guide](CREATOR_BUILD.md).

Reproduce after installing the repository’s locked development dependencies and building the creator:

```sh
src/creator/node_modules/.bin/tsx scripts/test-home-native.ts
src/creator/node_modules/.bin/tsx scripts/test-home-native.ts --packaged
```

The packaged driver inspects only the owned renderer through a loopback Chromium debugging endpoint. Main-process inspection remains disabled by the release fuses. Each receipt identifies its exact archive hash and test scope.
