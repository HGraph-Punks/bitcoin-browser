# Collector insights: inscriptions and Runes

Implemented September 19, 2026. This is a read-only information and navigation feature, not an appraisal, minting tool, collection verification service or trading integration.

## User experience

The inscription viewer keeps artwork primary. A compact strip shows sat rarity and up to three traits; **Details** contains explanations, scheduled rarity-class supply, inscription history, fees, postage, sat name, mined block and current location. Notation, mining cycles, the six-class guide and all prior technical/source fields remain in closed native disclosures. Save, bookmark, Record, Graph, Inspect, preview backgrounds/zoom, original documents and format-specific controls are retained.

Gallery cards show available rarity and up to two traits. **Collector trait** combines with the existing media filters. Both operate on the loaded page only, not a global rare-sat or trait index. The coverage summary distinguishes known non-common records from records without supplied rarity; it is not a distinct-sat count across the entire index. Search/block drafts survive publication; unchanged results do not remount the gallery. Real data refreshes retain the selected filters and filter focus.

Rune detail pages add **Supply at a glance**: cap utilization, remaining mint slots, initial-allocation share and burned share. Exact minted/unissued units accompany the existing supply and mint-window facts. Listing cards include supply and cap progress when structured data is available. **Mint status** combines with name filtering on the current page. Bare HTML listing names remain unknown, not “fixed supply.” Same-snapshot background publications preserve detail disclosures, focus and bookmark updates.

## Data and definitions

### Inscription provenance and traits

The gallery's existing `/r/inscription/<ID>` metadata reads now retain validated `sat`, recognized `charms` and `timestamp`. The existing bounded 24-card page, four-worker concurrency, byte limits, cancellation and source routing are unchanged. The viewer uses the already-resolved record, including `fee`, `value`, `delegate` and any supplied `parents`. No new automatic requests are introduced. See the [recursive endpoint contract](https://docs.ordinals.com/inscriptions/recursion.html).

Mainnet sat calculations use exact `BigInt` arithmetic, the 50-BTC initial subsidy, integer-truncating halvings every 210,000 blocks, difficulty boundaries every 2,016 blocks, and the scheduled total of 2,099,999,997,690,000 sats. Work is bounded by 33 subsidy epochs. Sat zero and all final-supply boundary values are handled explicitly. Other/unknown networks do not receive this mainnet calculation. See [ordinal theory and rarity](https://docs.ordinals.com/overview.html) and the upstream [`Sat` implementation and test vectors](https://github.com/ordinals/ord/blob/master/crates/ordinals/src/sat.rs).

| Class | Mainnet rule, with rarer boundaries taking precedence | Sats over full issuance schedule |
| --- | --- | ---: |
| Common | Any offset other than the first sat of a block | 2,099,999,990,760,000 |
| Uncommon | First sat of an ordinary block | 6,926,535 |
| Rare | First sat at a difficulty-period boundary | 3,432 |
| Epic | First sat at a halving boundary | 27 |
| Legendary | First sat at a six-halving cycle boundary after genesis | 5 |
| Mythic | Sat zero | 1 |

These disjoint scheduled counts sum to the scheduled sat supply. They include future issuance, not just circulating sats, and are not counts of inscriptions, sale listings or collectible pieces. The UI labels this distinction beside the selected class and in the guide. Reference: upstream [`Rarity` supply implementation](https://github.com/ordinals/ord/blob/master/crates/ordinals/src/rarity.rs).

Mathematical traits are **9ball** (mined in block 9), **palindrome** (sat number reads the same both ways) and **coin boundary** (sat number divisible by 100,000,000; not a one-BTC balance). The same local projection provides sat name, decimal/degree notation, zero-based mining epoch, cycle, difficulty period and block offset. These follow the upstream `Sat` implementation linked above.

Recognized source charms also include cursed, vindicated, reinscription, unbound, lost and burned. The allowlist is bounded to the first 32 supplied entries, deduplicates values, and ignores unknown labels and markup. Negative inscription numbers can establish the historical cursed-number trait; vindication is never inferred merely from a post-jubilee height. See the [upstream charm enum](https://github.com/ordinals/ord/blob/master/crates/ordinals/src/charm.rs) and [inscription numbering](https://docs.ordinals.com/inscriptions.html).

Each trait is attributed to either a local sat calculation, a supplied charm or a negative inscription number. Contradictory rarity charms and contradictions with a calculated sat trait produce a visible warning. A local result takes precedence for calculable traits, without claiming the source-provided sat number itself has been independently verified. No rarity charm plus no valid sat number is **unavailable**, never implicitly common. A metadata-failure record contributes no traits.

Inscription block and sat-mining block are deliberately separate. Postage is the containing output's BTC value expressed in sats, not an asking price or a value assigned to each inscription sharing that output. Reveal transaction, sat, block, current address/output, delegate and up to 24 supplied parent references open normal validated browser routes. Invalid/sentinel locations are not turned into links. [Declared parent provenance](https://docs.ordinals.com/inscriptions/provenance.html) is not a recursive-depth measurement or proof of official collection membership. Missing parents are not proof of no parents; the separate paginated parent/child endpoints are not fetched by this feature.

### Rune supply insights

Runes are fungible; this feature does not assign an NFT-style rarity score. It builds on the existing normalized Ord Rune data and its u128 validation. Amounts remain integer strings/`BigInt` until exact decimal formatting. The [Runes specification](https://docs.ordinals.com/runes/specification.html) defines the amount, cap, premine, divisibility and burn semantics used here.

The additional projections are:

- Minted units = completed mints × amount per mint.
- Remaining mint slots = cap − completed mints.
- Unissued units under cap = remaining slots × amount per mint.
- Mint progress = completed mints ÷ cap.
- Initial allocation share = premine ÷ (premine + cap × amount per mint).
- Burned share = burned units ÷ all units created.

Cap utilization is not supply utilization; premine share is not current creator ownership; burned share uses created supply, not the maximum. A remaining cap can coexist with a closed/not-yet-started mint window. The source-reported mint status is explicitly a retrieval-time snapshot, not a live permission or guarantee that a proposed transaction would succeed.

Percentage arithmetic truncates to two decimals. A positive ratio below 0.01% is shown as `<0.01%`; an almost-complete ratio never rounds up to 100%. Only the bounded 0–10,000 progress-bar value becomes a JavaScript `Number`. Zero denominators and totals beyond the protocol's representable amount range stay unavailable; inconsistent input does not yield calculated insights. Exact existing supply/mint fields remain available independently.

## Privacy and boundaries

No new provider, account, dependency, API key, IPC channel, credential operation, wallet capability, content permission, remote image or market-data feed is added. Filtering is local. Existing metadata requests and thumbnails retain the browser's selected network, local-only/offline policy, cache, limits and cancellation. The collector layer neither executes inscription content nor evaluates provider markup. Existing previews still contact configured sources according to existing policy.

Cached records created before this feature may lack gallery rarity fields until explicitly refreshed online. Sources without sat indexing may return `sat: null`; supported rarity charms can still be shown as source-reported. Ord's recursive sat endpoint lists inscriptions and is not treated as a rich sat-details endpoint. No automatic sat-index scan, parent traversal or recursion analysis is triggered.

Not included: market/floor prices, trading volume, holder concentration, historical transfers, global rare-sat searching, artwork trait ranks, verified collection membership, or an “all traits” claim. Those require separate reliable data contracts and privacy decisions. Existing developer recursion inspection remains accessible.

## Verification and manual acceptance

Automated coverage exercises the real renderers with a bounded DOM collaborator, normalized provider fixtures, protocol arithmetic, and actual page publication. It covers all six classes, all halving epochs, terminal sat/name vectors, invalid and unsupported-network input, missing/conflicting charms, exact u128 arithmetic, combined filters, native navigation, zero/unknown/cached data, preserved focus/disclosures and bounded metadata work. These are not native pixel-layout, screen-reader or real-provider completeness certifications.

Manual checks for the testing browser:

1. Open **Inscriptions**, combine **Collector trait** and media filters, clear an empty combination and confirm the page-coverage wording. A page with no rare sats is a valid outcome, not a failed search.
2. Open an inscription and **Details**. Compare mined versus inscribed block, fee/postage, sat name and available source charms. Inspect the collapsed rarity guide and raw source fields. Confirm artwork zoom, Original, Save, Graph and Inspect still work.
3. Compare a source with sat indexing to a source without it. Unknown data must remain unavailable. Test an existing cache record and refresh explicitly; do not enable a new remote service just for these fields.
4. Open **Runes**, combine name/mint filters and inspect a detailed Rune. Check a fixed allocation, an open mint, an exhausted/closed mint, and a source without mint status. Remaining capacity must not imply an open mint.
5. Check light/dark themes, a narrow or zoomed window, keyboard labels/focus, long IDs and large quantities. Background cache/bookmark updates should not collapse detail disclosures or lose focused controls.

See [implementation status](IMPLEMENTATION_STATUS.md) for the test-run and source-launch evidence. Existing broader beta qualification/release gates are unchanged.
