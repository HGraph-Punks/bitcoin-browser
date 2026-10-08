# Library browser and inscription report review

The supplied `inscription-library.md` is now a searchable discovery collection in the desktop application. Open **Explore library catalog** on the home screen, or **Libraries → Browse possibilities** inside a project.

The browser groups libraries by what someone wants to create: art and 3D, games and physics, animation, sound and media, data and charts, styles and type, utilities, Bitcoin data, and frameworks. Search includes use cases, package versions and complete inscription IDs. Details provide editable examples, native clipboard actions, source links, immutable IDs, license status, dependencies and scoped qualification evidence. Starting an experience creates a separate project; adding a library preserves the existing page and retains its credits.

## What is available

**Use now** offers nine entries: the existing Three.js r178, p5 1.11.2, p5 2.0.1, Phaser 3.80.1 and Tone 15.0.4, plus these additions:

| Library | Creation use | Working experience | Qualification scope |
| --- | --- | --- | --- |
| Matter.js 0.19.0 | Gravity, collisions, physics playgrounds | Falling shapes | Exact upstream browser artifact; standalone MIT notice retained. Native preview tests check drop, gravity, pause, reset and reduced motion. |
| anime.js 3.2.1 | SVG, typography and element animation | Motion study | Exact upstream browser artifact; MIT notice retained. Native preview tests check rearrange, play, pause and reduced motion. |
| D3 7.8.5 | Charts and interactive data stories | Data garden | Exact upstream browser artifact. Native preview tests check visible SVG bars, changed values, reset and accessible text values. Bundled dependency notice review remains pending for production. |
| JSZip 3.10.1 | In-browser archives and collections | Copyable archive example | Exact upstream browser artifact. Native workflow tests create ZIP bytes from a small trusted string after a real user click. Bundled dependency notice review remains pending for production. |

Three’s core remains an automatically resolved dependency. p5 versions cannot be combined in one project. Capability categories do not imply that every entry has completed publication qualification.

## How the report was reviewed

The ingestion script preserves **149 distinct inscription IDs**, their inventory names, alternate labels, source lines and reported limitations. **Discover more** exposes candidates and historical artifacts. **Needs review** contains eight distinct IDs flagged by the report for known affected versions or unresolved metadata. These discovery records cannot be added through `library.add`; their names do not grant execution or a trusted sanitizer/cryptography badge.

The report’s citation placeholders are not reproducible source evidence. The imported claims remain labeled as report discoveries. The independent expansion review fetched public gateway content without evaluating it, compared pinned upstream artifacts, retained content hashes and full upstream notices, and checked a second gateway. These reads do not authenticate an uploader or establish independent mainnet consensus verification.

Four additions matched exact upstream bytes. Several other promising entries remain discoverable because their provenance or runtime format is unresolved. In particular, the supplied pako inscription is an **ES module repackaging**, not the classic upstream `pako.min.js`; fflate is a minified repackaging rather than the upstream `esm/browser.js`; the inspected Marx CSS claims 4.1.1 but that exact version was unavailable in the checked upstream tags/npm release; and seedrandom has a different packaged notice/body from the initially compared minified artifact. None of these mismatches is proof of malicious code. They require a documented transform or exact artifact match before promotion. React/R3F, Three addons, audio workers/WASM and fonts also need matched dependency sets, formats, permissions and license checks rather than independent automatic includes.

The report’s DOMPurify 3.1.2 restriction is consistent with the [maintainer’s nesting mXSS advisory](https://github.com/cure53/DOMPurify/security/advisories/GHSA-gx9m-whjm-85jf). The [Axios advisory](https://github.com/axios/axios/security/advisories/GHSA-wf5p-g6vw-rhxx), [Moment advisory](https://github.com/moment/moment/security/advisories/GHSA-wc69-rhjr-hc9g) and [CryptoJS advisory](https://github.com/brix/crypto-js/security/advisories/GHSA-xwcq-pm8m-c4vf) support keeping their report-listed versions under review. This is a bounded review of identified findings, not a claim of complete current advisory coverage.

## Maintain the collection

```sh
node scripts/ingest-library-research.mjs
node scripts/expand-library-catalog.mjs
npm run test:experiences
node scripts/refresh-expansion-qualification.mjs
npm run check
npm test
npm run test:native
```

Ingestion is local and inert. Expansion research downloads bounded public bytes and notices without executing code. Runtime qualification intentionally runs selected, hash-pinned browser code in owned isolated previews. The refresh script derives runtime flags from receipts whose inscription IDs and hashes match; absent or mismatched receipts cannot promote a claim. New catalog promotions require an explicit code/review change, not a friendly package-name upgrade.

AI connections can use `library_search` for supported libraries and examples, and `library_research` for the supplied discovery inventory. `library_inspect` and `library_add` continue to accept supported catalog keys only. Research browsing does not expand filesystem, wallet or publication permissions.

The earlier signed RC7 archive predates this work. New source and its eventual package need their own qualification receipts; the RC7 release manifest cannot certify the expanded catalog.
