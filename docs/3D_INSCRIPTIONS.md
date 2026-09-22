# 3D inscriptions

Inscribed glTF 2.0 (`model/gltf+json`) and GLB 2.0 (`model/gltf-binary`) files now open in an interactive **3D view** instead of being handed to Chromium as an unsupported document. The original Runestone example is inscription `ed76bf35918948b8b78be0e6397ad4916d926dd3d65679a8b7e67d8699a672a0i0`, number **63,140,674**.

## Viewing

The model is centered and fitted to the canvas. Locally generated studio lighting and an environment map illuminate metallic/glossy surfaces; original geometry, materials and texture bytes are retained. Drag or use the arrow keys on the focused canvas to rotate. Scroll, pinch, use the +/− buttons, or press +/− to zoom. **Reset view** or Home fits the model again. **Auto-rotate** is opt-in. Models with animations expose a play/pause button and, when applicable, an animation selector; motion does not start automatically. Rendering is demand-driven while idle and pauses when the document is hidden.

Appearance backgrounds remain available. **Original** explains the file format and retains **Save original**, which saves the unchanged inscription through the existing native save workflow. Metadata, bookmarks, Record, Graph and Inspect remain available. The gallery and popular cards do not download or execute 3D models automatically.

Readiness means the model has reached its first draw, not merely that its iframe loaded. The internal loader has a 45-second deadline and the containing view has a 60-second startup deadline. Invalid data, missing resources, unavailable graphics and unsupported formats provide recovery text, **Retry 3D view**, and Save. Navigation and mode changes retire the frame; the viewer cancels fetches/animation and disposes textures, bitmaps, geometry and graphics resources.

## Isolation and bounds

- Rendering code is the pinned **Three.js 0.186.0** production dependency (MIT), served locally through an exact asset allowlist. Its installed LICENSE ships with the dependency. Only import specifiers for those bundled modules are adapted by the protocol; no model data is turned into executable code.
- The viewer uses an opaque `sandbox="allow-scripts"` iframe, without preload, IPC, wallet, forms, popup, top-navigation or download permissions. Its own CSP denies outside scripts, network URLs, workers, nested frames and active objects, even when general inscription HTTPS compatibility is enabled.
- Main-process `ord://model-data/<id>` and `ord://model-resource/<id>` projections permit exact inscription IDs and GET/HEAD only. They reuse the existing resolver, source/cache, offline/local-only settings, routing cancellation and any lower configured byte limit. Responses rebuild inert headers and do not forward provider cookies or control headers.
- Models can reference embedded base64 resources and canonical `/content/<id>`, `ord://content/<id>` or bare inscription IDs. Arbitrary external URLs, local paths, relative filenames, scripts, active images and unowned blob URLs are rejected. Validated resources become owned blob URLs before the engine parses the model; the engine's loading manager rejects all other URLs.
- Limits: 32 MiB root file, 16 MiB per resource, 64 MiB aggregate buffers/downloads and separately bounded accessor allocation; 2,048 nodes, 1,024 draw primitives, 3 million drawn indices/vertices including morph targets, bounded scene depth, animations and lights. Cyclic/repeated node graphs are rejected. PNG/JPEG/WebP texture headers are checked before decoding: 8,192 maximum dimension, 16 megapixels per image and 32 megapixels total. Drawing buffers are capped at 4 megapixels and 4,096 on either axis. These are guardrails, not a guarantee against all GPU/decoder defects or memory exhaustion.
- Parent messages accept only fixed status/error states from the exact owning opaque frame and selected ID. Appearance messages carry only an allowed background name. Local diagnostics retain at most 20 fixed ready/error markers per window, with inscription IDs and URLs redacted; no raw model text, credentials or wallet information is logged by this marker.

## Current limits

This is not a universal 3D file importer. OBJ, FBX, USDZ, glTF 1.x, Draco/Meshopt compression, KTX2/Basis textures, GPU instancing and AVIF model textures are not enabled. Unsupported required extensions fail clearly rather than silently producing a misleading preview. Common glTF physical-material extensions, WebP textures, skins and bounded animations are supported by the bundled loader. Models requiring external assets or an unavailable on-chain dependency need another viewer or source. Save preserves the original even when preview is unavailable.

The [format-coverage pass](INSCRIPTION_FORMATS.md) adds ASCII/binary STL (`model/stl` and `application/sla`) to the same studio viewer: 32 MiB maximum, up to 250,000 triangles and 512 ASCII solids, with finite coordinate validation before the loader. It also fixes bounded Brotli/gzip/deflate decoding for model and texture projections. Original cached/saved bytes remain unchanged.

## Verification and manual acceptance

Deterministic tests cover the protocol allowlist and transitive module imports, real glTF/GLB geometry parsing with Three.js, model/resource admission and limits, safe error responses, deadline and message ownership, retry/original behavior and teardown. The public Runestone bytes were separately passed through the same admission and Three.js parser: 3,967,899 file bytes, 1,256 vertices, 481 triangles, two 2,048 × 2,048 PNG textures, preserved color/normal maps and metallic/glossy material. That parser check uses a header-only image-bitmap collaborator; it is not native texture decoding or GPU proof.

Native visual acceptance should check Runestone on dark/light backgrounds, drag/pinch/keyboard/reset, resize with Details open, one animated GLB, offline cache hits/misses, a blocked external-buffer model and navigation during loading. First-draw diagnostics are useful runtime evidence, but do not prove visual fidelity, screen-reader behavior or cross-platform graphics compatibility. Packaged distribution qualification and the broader beta gates remain separate.

On 2026-09-12 the refreshed macOS source-testing process 52118 reported `renderer.model` state `ready` at **07:35:21.017 UTC**, after opening the exact Runestone deep link. This is native first-draw evidence in addition to the CPU parser tests; interactive screenshot/visual acceptance has not been performed by the agent.

References: [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html), [OrbitControls](https://threejs.org/docs/pages/OrbitControls.html), [Runestone inscription reference](https://ordiscan.com/inscription/63140674).
