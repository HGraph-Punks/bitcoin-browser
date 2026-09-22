# AI experience and live-model qualification — 2026-09-19

This pass used the already-loaded **`openai/gpt-oss-20b` in LM Studio at loopback port 11434**. Model metadata reported a **loaded context of 8,192 tokens**, distinct from its advertised maximum of 131,072. No model was installed, loaded/unloaded through a management API, or reconfigured. No saved conversations, user profile settings, wallet state, credential values or environment files were read. Test conversations were synthetic; public-data checks used public Bitcoin identifiers and isolated in-memory diagnostic state.

## Problems reproduced and corrections

The valid baseline ran ten fixed questions through production LocalAiManager, ProviderManager and RecursiveResolver. Bitcoin responses were synthetic, while inference used the real loaded model. An earlier diagnostic had an incorrectly constructed source fixture; that run was discarded for source-backed conclusions. The harness now checks provider initialization, and regression tests verify its actual fixture values.

The model initially misdescribed Rune storage, confused provenance with UTXO ancestry, miscalculated Rune divisibility, asked for an already supplied inscription ID, and fabricated a synced node after only source discovery. It produced tables and dead-looking internal links, suggested internal API calls to users, and sometimes offered unsupported Rune-holder/provenance queries. Prompt instructions alone did not reliably correct all of these behaviors.

The implementation now provides:

- **Exact inscription retrieval before inference** for narrow, single-ID lookup questions. Valid IDs are parsed by the browser rather than retyped by a model. Ambiguous numbers, multiple IDs, hypothetical/negated requests and recursion/provenance workflows retain their existing paths.
- **Actual local Core status checks** for direct local-node sync questions. These call the closed read-only status operation and return a browser-authored snapshot. Connectivity, source discovery and leaving initial block download are not represented as proof of being at the network tip. No public fallback, service installation or credential disclosure is added.
- **Browser-authored Rune statistics** after a successful Rune lookup. Exact formatted supply, burns, premine shares, mint capacity and mint status cannot be replaced by model arithmetic or invented holder-history instructions. Multiple grounded summaries remain bounded; other result cards stay available. The model still selects tools for ordinary Rune discovery. Unsupported/missing market data remains unavailable, not zero.
- **Safe failure summaries** when reads fail and only editorial cards—or no cards—exist. A confident model response cannot turn that failure into a supposedly current on-chain result.
- **Canonical target support** in entity tools. Copying a returned `rune:…` or `inscription:…` target works when it matches the requested kind. Wrong kinds, URLs, paths and malformed values remain rejected before a lookup.
- **Shared collector projections**, using the same mainnet sat calculations and bounded Rune integer math as the browser. The model receives sat rarity, mined block, traits and attribution, conflicts, inscription fee/postage, divisibility-adjusted token amounts and exact collector percentages. Missing metadata remains unknown. No additional index, market API or dependency was introduced.
- **Narrow concept-question grounding** with fewer irrelevant tool schemas and a browser-maintained protocol primer. This improves explanations without disabling factual asset lookups. It is not a general natural-language parser or a guarantee that the loaded model will always follow the reference.
- **Per-question restrictive source policy** for recognized local-only, Core-only and cached-only phrasing. This is enforced before tool dispatch, not entrusted to model arguments. It only narrows global settings. Ambiguous privacy requirements should still be set explicitly in Sources/Settings; the natural-language matcher is not a replacement for those controls.

Protocol grounding follows the primary [inscription documentation](https://docs.ordinals.com/inscriptions.html), [Rune specification](https://docs.ordinals.com/runes/specification.html), [provenance rules](https://docs.ordinals.com/inscriptions/provenance.html), [multiple-parent implementation](https://github.com/ordinals/ord/pull/3227) and [recursive endpoints](https://docs.ordinals.com/inscriptions/recursion.html). In particular, inscriptions use Taproot witness envelopes; Rune messages use an OP_RETURN runestone; provenance uses explicit parent references; content recursion does not require a cycle back to its starting inscription. Sat/collector definitions and numeric limitations remain documented in [Collector insights](COLLECTOR_INSIGHTS.md).

## Chat presentation

The existing single vertical conversation scrollport, anchored composer, retained tab/session state, cancellation and progressive disclosure remain intact.

- Small semantic tables, emphasis and separators render with text nodes only. Tables have column headers and keyboard-focusable horizontal scrolling when needed, with no nested vertical table viewport. Table width is capped at eight columns and the existing 12,000-character answer limit still applies.
- A model-written internal reference becomes a user-operated button **only if its exact canonical target matches a validated card already returned for this turn/network**. The click uses the existing new-tab navigation and rechecks the currently selected network. Unmatched/internal guesses, arbitrary URLs, HTML, images, scripts and fenced code remain inert. This is not Markdown web navigation.
- Answers distinguish **AI explanation**, **source snapshots**, **curated examples** and **Browser-generated lookup summary**. These labels do not certify model prose, freshness, authenticity or financial value. Cards still disclose source, network, fetch time and cache status.
- Source-backed cards precede editorial examples. Inscription rarity/traits and Rune outstanding supply/mint status are foregrounded; all remaining facts stay under Details & source.
- Contextual **Explain sat rarity**, **Inspect recursion**, **Mint & supply** and block-inscription prompts use validated result identifiers, not model/source prose. They fill the composer without sending. An existing unsent draft can be restored, and follow-up buttons are disabled during a pending request.
- Six first-question choices introduce the main browsing paths, including sat rarity. The model selector tooltip shows reported loaded context capacity when available.

## Context and authority

The manager uses bounded `loaded_context_length` metadata, not advertised model maximums. Missing metadata uses an 8,192-token working budget. Request-size estimation uses UTF-8 JSON bytes and message overhead, reserving response space and a margin; it is a heuristic, not a tokenizer. It may drop oldest complete history turns, then complete older tool-call/result groups, then produce valid bounded JSON excerpts. The current question is never removed. Visible chat and full result cards are unchanged, and shortening is disclosed.

Server context rejection produces fixed `AI_CONTEXT_LIMIT` recovery text without echoing its body, prompt, paths or token. Existing 4,000-character question, 12,000-character answer, 10-call/7-round, 24-card, response-byte, request-deadline, cancellation and source-routing ceilings remain. Responses reserve 1,536 generated tokens, or 1,024 for reported capacities below 8,192. The browser does not alter LM Studio GPU/context settings. The API remains the existing [LM Studio-compatible completion/tool flow](https://lmstudio.ai/docs/developer/openai-compat/tools) with [model metadata discovery](https://lmstudio.ai/docs/developer/rest/endpoints).

No wallet access, signing, arbitrary RPC, external browser control, model-server plugin execution, filesystem reading, new renderer network authority or credential context is added. Source operations remain allowlisted and read-only. Browser-managed Core authentication, if needed in ordinary use, is internal to the existing provider boundary and never sent to the AI.

## Evidence

The final automated suite passes **2,123/2,123 tests**, including **145 AI integration, data, recursion, IPC, experience and controlled-DOM tests**. The new deterministic experience suite is also included in the early-beta security runner. These tests do not need a real model, funded wallet or public Bitcoin service.

Selected live checks used the production paths and the unchanged local model:

| Check | Data and result | Observed duration |
| --- | --- | --- |
| Local node sync | Synthetic Core health adapter: height 100, headers 101, 95% progress, initial download and pruning enabled. Only `getblockchaininfo` selected; browser summary correctly says still syncing. | ~3 ms, no inference needed |
| Collector metadata | Synthetic inscription: uncommon sat in block 9, 9ball/coin boundary, fee 1,234 sats, postage 546 sats. Exact supplied ID resolved before inference; all values reached model context. | ~7.1 s |
| Follow-up context | Two real model turns with the actual renderer history projection. The second turn selected the same inscription and repeated the correct fee/postage after another source lookup. | ~6.2 s combined |
| Long conversation | Eight synthetic history messages; older context shortened with a visible note, current question retained, block count resolved from the source. | ~4.7 s |
| Public 3D Runestone inscription | `ed76bf…a672a0i0`: Ordinals.com metadata, common sat, mined block 342045, inscription block 832947, fee 109773730 sats and postage 546 sats. AI read metadata, not the model/gltf artwork. | ~6.8 s |
| Public DOG Rune | Model searched featured assets and looked up the exact Rune. Browser summary showed 99,975,593,202.33 outstanding, 100 billion created/maximum, 24,406,797.67 burned, 100% premine and no public mint at that snapshot. No holder/provenance fiction or market-price claim. | ~10.7 s |
| Public block 840000 | Ordinals.com returned 3,050 transactions and 2,325,218 bytes. The model repeated them correctly; its exact block reference is now eligible for an inline result button. | ~4.1 s |
| Public recursion discovery | Three source-backed examples: 42 observed content references for Blob #1 (partial scan), 11 for Oscillations and 7 for Chordinals. Limits and static-observation caveats retained; no inscription code executed. | ~8.2 s, no inference needed |

These are observations from this run, not availability, latency, price, complete-search or universal model-accuracy guarantees. Public supply/burn data can change. Real Core RPC credentials and real Ollama inference were not exercised in this pass; their contracts remain fixture-tested.

**Remaining model limitation:** free-form explanations still require verification. During testing this model sometimes inserted a colon into an illustrative inscription-ID notation or embellished a protocol explanation despite the reference. Source lookup validation is not relaxed to accept malformed IDs. Successful grounded Rune/node/recursion summaries and safe failed-read responses are therefore deliberately browser-owned; ordinary conceptual prose is visibly labeled as an AI explanation. This pass does not claim to make a 20B model an infallible Bitcoin authority.

## Repeatable diagnostic and manual checks

The opt-in `scripts/test-local-ai-experience.mjs` is inert with no arguments or `--help`. It requires an explicit loopback server, already-loaded model, `--run`, data mode and case. `fixture` simulates Bitcoin responses while using real inference; `public` queries default public Ord/explorer sources with in-memory state, never a user profile. It emits bounded public/synthetic answers, card facts, activity, token counts and tool names, not hidden reasoning or credentials. Nothing writes report files or calls model-management endpoints. Review output before sharing.

```sh
node scripts/test-local-ai-experience.mjs --help
node scripts/test-local-ai-experience.mjs --run --server http://127.0.0.1:11434 --model openai/gpt-oss-20b --data fixture --case all
```

The eleven cases cover basics, block lookup, Rune statistics, collector details, recent listings, local sync, recursion, provenance, wallet refusal, two-turn follow-ups and long context. An HTTP-successful model answer is not automatically a semantic pass: compare its claims against the actual returned facts and activity.

The supported interactive Browser runtime was unavailable. Controlled DOM/CSS tests verify actions, safe rendering, retention and scroll structure, but **native visual layout and screen-reader behavior remain manual acceptance**. Test narrow/wide and short windows, both themes, horizontal table navigation, inline results and sidebar return, draft restore, Stop/retry, low-context recovery and a downloaded Ollama model. Broader native Electron shutdown/sandbox, signing/notarization, wallet and cross-platform beta gates remain unchanged.

Latest source was reopened on `satnav://ai` as PID **82818**, preserving the existing disposable test profile after the verified previous process exited gracefully. Shell-load and AI-workspace-ready markers were observed at **2026-09-20 05:13:29.822 / 05:13:29.882 UTC**. Only fixed markers from a bounded log tail were inspected. The application is left running; the restart clears memory-only chats and requires an explicit reconnection before a new model request. Static verification also passed 337 JavaScript syntax checks, 434 inspected files, generated-viewer freshness and whitespace checks.
