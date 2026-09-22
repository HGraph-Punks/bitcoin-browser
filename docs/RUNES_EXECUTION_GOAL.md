# Runes interface integration

## Active scope

The user narrowed the asset work to **Runes only**. BRC-20 is removed from implementation and acceptance scope. No BRC-20 sidebar, indexer integration, account setup, API key, or dependency is to be added. The earlier combined-asset goal is superseded by this document.

Deliver a first-class, read-only Runes destination alongside Inscriptions, with approachable browsing, exact-name/ID lookup, usable token details, native navigation/bookmarks, and progressive technical disclosure. Preserve every existing browser, inscription, wallet, provider and local-node function.

## Implemented interface contract

- Runes sidebar, Home shortcut, command-palette entry and guided Bitcoin lookup type.
- Recently created / earlier Rune pages from the configured Ord index, bounded to 100 source entries with sequential native pagination. No per-card request fan-out.
- Full Rune name, spaced/unspaced name, Rune ID and copied-link lookup. Lowercase names and spaces/dots are accepted in the dedicated form. Bare numeric Rune IDs are recognized by navigation. Page filtering is explicitly local, not global keyword search.
- Dedicated detail page: protocol ID/name/number/symbol, exact outstanding and total supply, burned quantity, premine, decimal places, mint availability at retrieval, mint amount/cap, maximum supply and effective block bounds. Creation transaction/block and related inscription links remain native.
- UNCOMMON•GOODS is identified as predefined; timestamp zero and its all-zero etching transaction are not presented as an ordinary 1970 creation event or usable creation transaction.
- Existing bookmarks, history, tabs, network selection, source routing, local-only and offline caching apply unchanged. Drafts, filter text, focused input and page scroll survive same-tab delayed result/error publication.
- Readable loading, empty, unavailable, offline, cached and technical states; no fabricated price, holder count, balance or activity.

## Source and correctness contract

Use the existing Ord source authority and Rune capability; add no remote provider defaults or credential/IPC permissions. Validate current Ord JSON envelopes and support the public source's bounded HTML-only representation when JSON is disabled. Parse HTML as inert data in the main process; never embed remote markup/media or navigate pagination supplied by a provider without validating it.

Preserve u128 numbers from their original JSON numeric tokens and carry decimal strings across normalization, cache and renderer. Use BigInt arithmetic and apply divisibility exactly once. Validate Rune modified-base-26 name and u64:u32 ID bounds, response identity, required fields, quantities, duplicates and sequential pages. Bound response bytes to 256 KiB and the complete lookup, including JSON-to-HTML fallback, to the caller deadline (maximum 60 seconds). Preserve cancellation reason and admit no fallback, cache write, health success or stale publication after cancellation.

References: [Ord API](https://docs.ordinals.com/guides/api.html), [Runes specification](https://docs.ordinals.com/runes/specification.html), [normative Rune name implementation](https://github.com/ordinals/ord/blob/master/crates/ordinals/src/rune.rs). Local Ord needs Rune indexing. Public-source availability and layout can change; unsupported responses must fail safely with a recovery path.

## Verification and limits

Execute actual parser, provider, normalizer, manager and renderer paths with bounded collaborators. Cover precision, malformed/hostile responses, missing/zero data, pagination, search, bookmarks, links, delayed results, focus/drafts, cancellation, network/local-only and offline cache isolation. Run the full Node 22 verification command on unchanged source inputs; record live public-source results separately from fixtures. Preserve earlier unrelated fixes.

Refresh the user's source app using their existing disposable manual-testing profile after verification. Normal quit only; no unrelated processes, forced termination, credential inspection/manual modification, signing or new profile authority. Passive shell-load/process checks do not establish visible UI, keyboard, accessibility, layout, packaging or lifecycle acceptance. If browser automation is unavailable, record it and provide a short hands-on test path.

This is the Runes interface integration, not a trading or portfolio implementation. Address-level Rune balances, holder rankings, full transfer activity, prices/volume and index-wide keyword search are not included. They require additional source qualification (and, where applicable, an explicit source/privacy choice). Do not call those capabilities implemented or silently display missing values as zero. Broader external-beta startup/shutdown, native-node/full-sync and trusted-distribution gates remain separate and open.

The thread's earlier beta goal remains paused and unfinished. The goal tool refused a replacement because an unfinished goal exists; no false completion or blocked state was used to bypass that restriction. This document records the current user-authorized working scope.
