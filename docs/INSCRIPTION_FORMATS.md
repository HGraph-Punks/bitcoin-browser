# Inscription format support

## Comparison scope

This pass compares ord.io's publicly indexed examples with **all 40 rows** of the official [Ord media registry at commit 899e309424dd60e1c8065a7727a76d9b675a6ac4](https://github.com/ordinals/ord/blob/899e309424dd60e1c8065a7727a76d9b675a6ac4/src/inscriptions/media.rs). The registry includes charset and codec variants, so 40 rows does not mean 40 unrelated file formats. A deterministic test preserves every row and its intended viewer/category.

On 2026-09-12, live HTTPS requests to ord.io failed certificate validation because its certificate was expired. Certificate checks were **not bypassed**. Indexed ord.io examples confirm [Markdown](https://www.ord.io/61932615), [MP4 audio](https://www.ord.io/102027296), [glTF](https://www.ord.io/63140674) and [GLB](https://www.ord.io/70262998); they do not establish an exhaustive current ord.io capability list. This is an implemented, tested format-coverage pass, **not a claim of independently proven live ord.io parity for every codec or extension**.

Ord permits arbitrary MIME-labelled inscription bodies. Registering a MIME type, displaying its bytes and faithfully rendering every possible encoding are different capabilities. In particular, Ord classifies CBOR, protobuf, torrents, opaque binary and STL as `Unknown`; this browser now provides an inert data inspector for the first four and a bounded 3D viewer for STL. [Ord inscription model](https://docs.ordinals.com/inscriptions.html)

## What opens in the browser

| Family | MIME types / files | Presentation |
| --- | --- | --- |
| Raster images | PNG, APNG, JPEG, GIF, WebP, AVIF; additionally BMP and ICO | Centered fit-to-view artwork, actual size, zoom, crisp pixels and background choices. Native decoder retains supported animation. APNG also has passive gallery thumbnails. |
| JPEG XL | `image/jxl` | Native decoder when available; otherwise a bundled local WASM decoder in a terminable worker. The fallback is explicitly a **still-image compatibility preview**, not an animation/HDR fidelity guarantee. |
| SVG | `image/svg+xml` | Passive centered image by default. Original retains the existing opaque sandbox for authored scripts and recursive resources. |
| Interactive documents | `text/html` with or without UTF-8; additionally XHTML | Original authored document in the existing opaque sandbox. External networking remains blocked by default; existing explicit HTTPS compatibility is unchanged. |
| Readable data and code | Plain text/UTF-8, JSON, CSS, JavaScript including `application/x-javascript`, Python, YAML, PGP signature text; additionally XML, JSON-suffix MIME types, SQL and TOML | Theme-aware selectable text. JSON has formatted/source views and exact-source copying without rounding large numeric tokens. Code and signatures are displayed, not executed or cryptographically verified. |
| Markdown | `text/markdown`, UTF-8 variant; additionally `text/x-markdown` | Readable headings, paragraphs, emphasis, lists, task lists, tables, quotes and code, with a Source toggle. Raw HTML stays inert. Only approved on-chain/data raster images load; external images do not auto-fetch. |
| Audio | FLAC, MPEG/MP3, Ogg/Opus, WAV; additionally MP4/M4A, AAC, WebM and conventional MIME aliases | Native playback controls without autoplay. Codec support is runtime/platform-dependent; failure keeps Retry/Save recovery. |
| Video | MP4 and WebM; additionally Ogg video, QuickTime and M4V containers | Native playback controls without autoplay. A recognized container does not guarantee its embedded codec is supported. |
| Fonts | OTF, TTF, WOFF, WOFF2 and conventional MIME aliases | Isolated specimen, editable sample text, size slider, letters/numbers/symbols. Fonts are never installed in the OS or applied to browser/wallet UI. Missing glyphs fall back to the browser font. |
| PDF | `application/pdf` | Local PDF reader with pages, page-number entry, fit width, zoom, rotation and extractable text view. No PDF scripts, active annotation layer, forms, attachment opening or document-link execution. Password-protected files require a separate reader via Save. |
| glTF / GLB | `model/gltf+json`, `model/gltf-binary`, version 2.0 | Interactive studio-lit 3D, rotate/zoom/reset, optional rotation and animation. Bounded embedded and exact on-chain resources only. [Detailed 3D limits](3D_INSCRIPTIONS.md) |
| STL | `model/stl`; additionally `application/sla` | Validated ASCII or binary triangles rendered in the same 3D studio. Invalid coordinates, malformed data and excessive complexity fail before Three.js allocation. Microsoft `application/vnd.ms-pki.stl` is a trust list, **not** geometry. |
| Other data | CBOR, protobuf, torrent, octet-stream and unrecognized MIME types | Bounded hexadecimal/ASCII inspection with byte counts, format label and Save original. This is not a semantic CBOR/protobuf/torrent decoder. Executables and WebAssembly inscriptions are never run by this inspector. |

Inscriptions are still found through the existing source-wide number/ID/link lookup and gallery. Gallery filters now distinguish **3D**, **Documents** and **Fonts**, while retaining all previous categories. These filters apply to the current page, not a new global content index. Heavy readers/models are opened on selection, not run automatically in discovery cards.

## Preservation and recovery

Preview selects the appropriate view automatically. Existing Details, Record, Graph, Inspect, bookmarks, original-content access and native Save remain. For file formats that Chromium cannot display as a raw document, Original explains how to use Preview or Save rather than opening an unsupported iframe. Markdown's Source shows the original text independently of the reading layout.

Native images, media and original documents now have a 65-second startup recovery deadline. Model/document parent frames have a 60-second deadline and their internal loaders have a 45-second deadline. PDF page operations also have a 30-second deadline. Timers stop on success; disposal cancels pending work and retires owned frames/workers/blob URLs. A loaded HTML iframe can still run an inscription's own loading screen: iframe load alone cannot prove that arbitrary authored JavaScript finished successfully.

Brotli, gzip and deflate are decoded **once, with an output bound**, for text, thumbnail, model and document projections. This fixes compressed inscriptions that previously lost their `Content-Encoding` while retaining compressed bytes. Resolver/cache wire bytes and Original/Save behavior are not rewritten. Unknown/chained encodings fail explicitly rather than being guessed.

| Preview | Bound |
| --- | --- |
| Text and Markdown | 256 KiB; bounded text formatting / Markdown depth and DOM nodes |
| Font | 4 MiB input; 16 MiB declared expanded font size; bounded table directory |
| PDF | 32 MiB input; up to 10,000 pages; one visible page at a time; approximately 8 MP/8,192 pixels per canvas edge; 16 MP embedded-image limit |
| JPEG XL | 8 MiB input; 16 MP and 16,384 pixels per edge, checked before decoding |
| Binary inspection | 8 MiB input; first 4 KiB displayed with the full received byte count |
| STL | 32 MiB input; 250,000 triangles; 512 ASCII solids; finite bounded coordinates |
| glTF/GLB | Existing 32 MiB root, 16 MiB individual dependency, 64 MiB aggregate and model/texture complexity limits |
| Gallery raster thumbnails | 2 MiB encoded and decoded-byte projection bounds; not a guarantee about all native image-decoder allocations |

The resolver's own lower configured limits continue to apply. Limits reduce resource-exhaustion risk but are not absolute process-memory or execution-time guarantees for every malformed native decoder input.

## Isolation and dependency maintenance

Document readers execute in a dedicated `sandbox="allow-scripts"` opaque frame with no preload, IPC or wallet bridge. Their CSP allows only fixed local viewer assets, owned blobs, bounded document-data routes and passive on-chain thumbnails. It blocks arbitrary HTTPS/WSS, active objects, nested frames, form submission and access to application resources, independently of general inscription HTTPS compatibility. Parent messages require the exact owning frame, opaque origin, inscription ID, document kind and allowlisted message shape; external links are explicit user actions revalidated by the parent.

Main-process routes permit GET/HEAD, exact kinds/IDs and a fixed asset allowlist. The provider's actual MIME type wins over metadata. Responses rebuild inert headers, strip cookies/provider control headers, and reuse existing source, cache, offline/local-only and cancellation policies. No new provider account, tracking service or credential operation is introduced.

Runtime dependencies are exactly pinned: **PDF.js 6.3.289**, **Marked 18.0.12**, **jSquash JPEG XL 1.3.0**, and the existing **Three.js 0.186.0**. Licenses are retained in installed packages and generated workers. The jSquash project labels JPEG XL experimental; its fallback is deliberately limited and should remain in the dependency-review process. [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html), [jSquash JPEG XL](https://github.com/jamsinclair/jSquash/tree/main/packages/jxl)

Native testing found that a minimal classic worker starts in this Electron opaque sandbox while a minimal module worker fails. Both heavy readers therefore use prebuilt **classic** workers. Build-only **esbuild 0.28.2** produces the committed, local worker files; no bundler runs in the app or on inscription-controlled source. Run `npm run build:viewers` after changing worker inputs/dependencies. `npm run check:viewers` compares a fresh build to the generated bytes, and is part of `npm run verify`; stale bundles fail CI. This is not a release checksum/signing-manifest feature. Node 22.13+ is required; CI remains pinned to 22.23.2.

## Verification and remaining acceptance

Deterministic tests cover every registry row, added aliases, inert protocol responses, exact asset allowlists, compressed-input/output bounds, aborts, malformed fonts/JPEG XL/STL, Markdown injection and link policy, parent-message ownership, deadlines, retry/disposal, PDF controls and real decoder execution. The actual PDF engine paints authored fixtures with rotation and extracts text without executing their OpenAction. The real JPEG XL WASM decoder reproduces a lossless RGBA fixture; the generated classic worker decodes the same transferred fixture without a network function. The generated PDF worker starts its actual message handler. Both STL encodings pass the real Three.js loader.

Following the PDF skill's visual verification guidance, rendered PNGs of the public whitepaper's first page and both authored fixture pages were inspected. Text, contrast, shapes and page rotation appeared correct. This is document-render evidence, not a screenshot of the native application's toolbar, focus or accessibility behavior.

Native source-app process **65754** recorded ready for the [whitepaper PDF inscription #54](https://ordinals.com/inscription/85b10531435304cbe47d268106b58b57a4416c76573d4b50fa544432597ad670i0) at **2026-09-12 09:04:32.523 UTC**, the [WOFF2 specimen](https://ordinals.com/inscription/b95309571daf54fb67d80d19c4e8b28e851374c022d274aea5ac2e752c8274cei0) at **09:05:58.960 UTC**, and [Brotli-compressed Markdown](https://ordinals.com/inscription/cb60ace5f552ba99bf48b9a3f02242e9b86a68d4769da846b30e108314fdd16bi0) at **09:07:17.623 UTC**. Markers are bounded and contain only kind/state/normalized failure information, not content, IDs, credential values or wallet data. Temporary worker probes were removed.

Still requiring native/manual or release qualification: JPEG XL visual fidelity/animation variants; every audio/video codec on all advertised platforms; APNG animation; font shaping and missing glyphs; PDF keyboard/screen-reader and large/scanned/encrypted-document behavior; animated/complex GLBs, STL graphics and 3D interaction; offline cached versus missing dependencies; high-DPI/responsive layout; packaged dependency inclusion and native installers on each OS/architecture. TIFF, HEIC, OBJ/FBX/USDZ, glTF compression extensions and unsupported media codecs are not advertised as visual previews; original data remains inspectable/savable. The broader early-beta launch gates and wallet qualification are unchanged.
