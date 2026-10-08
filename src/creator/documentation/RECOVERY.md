# Source and publication recovery

## Saved source

Saved source revisions are immutable. A synchronized revision record is written before the atomic project pointer advances. Undo, redo, and restores create new revision numbers. An acknowledged saved edit remains in the recorded timeline. Use **History** to compare and restore it. A restored source revision cannot replace a frozen inscription plan.

The app also keeps desktop-only copies of source drafts. They are separate from source history and are bounded to 2 MB per file, 8 MB and 64 files per project. Copies include their source path, exact starting revision, timestamp, and SHA-256. Reads reject identity/hash mismatches and escaping paths. Older completion acknowledgements cannot remove a newer copy.

After an abrupt app termination, open the project again. Its newest unresolved copy opens in Code with a recovery message. **Review changes** combines it with current saved source using the recorded base revision. Review the complete result before saving. A copy already represented by saved source is removed. Other unresolved files remain available on subsequent opens. Recovery copies are written after a short pause; this is not a guarantee for every unacknowledged keystroke or a failed disk write.

If automatic comparison exceeds its work limit, the app retains the draft and offers complete manual editing. If a file has become a binary asset, export the draft and choose a different source path. Damaged records report an error instead of inventing replacement source.

## Publication states

The local publishing route can select mainnet or regtest; real mainnet release qualification is still pending. It records exact prepared commit/reveal transactions and content hashes before requesting owner approval. Private recovery material and authorization records are authenticated-encrypted; the vault key is protected by the operating system.

- **Quoted / Awaiting review:** inspect the exact resource. No funding-wallet signature or broadcast has been authorized. An expired unsigned review needs a new quote.
- **Awaiting signature / Signed:** keep the journal. Wallet or node refusal is a reason to inspect and resume the same reviewed plan, rather than construct another inscription.
- **Broadcast unknown:** a timeout does not establish failure. The engine queries the exact saved transaction IDs before retrying.
- **Commit broadcast / Recovery required:** preserve the reveal transaction and recovery descriptor. The intended inscription can require completing the saved reveal. Canceling cannot undo a transaction already accepted by the node.
- **Confirming / Indexing:** wait for both Core confirmations and a matching Ord block anchor. Served content alone does not establish confirmation.
- **Reorg:** the engine checks the same root on a new chain anchor and retrieves its bytes again.
- **Complete:** all required resource bytes and MIME types have been retrieved and verified. Export the receipt and retain the original network's evidence.

For an interrupted authorized publication, reconnect to the same backend and inspect its status before resuming. Owner recovery can explicitly complete a preserved canceled commit/reveal; an AI grant cannot undo owner cancellation. Revoking an assistant cancels its pending unapproved publication work, while already authorized/submitted transactions remain recoverable.

## Back up and restore

Close the application before copying its complete user-data directory. Keep `projects`, `drafts`, `deployments`, and the protected vault key together. Do not include private deployment directories in ordinary website exports or send them to an AI client.

A `.btcsite` archive backs up the selected current source and assets. It does not back up the full source timeline, connection grants, transaction journal, temporary recovery keys, or OS vault. A public receipt is evidence, rather than a backup of signing/reveal material.

OS-protected vault keys are tied to the operating-system protection mechanism. Copying encrypted files to another user or computer is not a qualified portable recovery procedure. Wallet recovery and portable wallet-key export are explicitly outside this release scope. If the protected key is missing while deployment records exist, the app refuses to create a replacement key. Restore a consistent backup for the original environment.

The disposable development network uses its own node, wallet, and chain directory. Restarting `dev:regtest` creates a different network. Saved IDs belong to the original chain; restarting a fresh launcher does not restore that chain.

## Current production boundary

The current adapter is restricted to macOS arm64, Core 31.1.0, Ord 0.29.0, mainnet or regtest, confirmed cardinal native Taproot funding, and its qualified MIME types. Actual mainnet execution and beginner wallet/service publishing require separate qualification. An encrypted funding wallet is unlocked directly in Core; the app reports a locked wallet before importing the temporary descriptor or signing. Fee replacement and cross-device custody recovery are not advertised. Developer ID signing/notarization and public distribution also need the owner's release credentials and authorization.

If macOS secure storage does not respond, the app returns an actionable error after 20 seconds and does not create a vault or prepare an inscription. Authoring remains available. Do not delete an existing protected vault to work around an access error. The final Developer ID package must pass Keychain creation and restart qualification; ad-hoc builds can behave inconsistently.
