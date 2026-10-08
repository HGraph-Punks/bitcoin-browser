# MCP construction interface

Updated October 8, 2026. The current server implements 46 tools, 11 resource registrations, and three prompts; this document also describes future operations required by [the implementation goal](../GOAL.md). Implemented tools cover authoring, assets, source merging, previews, deterministic builds, local regtest planning/quotes, owner-review requests, status, authorized resume, and durable deployment operations. [Implementation status](IMPLEMENTATION_STATUS.md) records the tested subset and remaining work. Publication access requires an explicit additional project grant; no MCP approval command exists. Full test profiles, general operation progress/cancellation, production backends, and other client/platform qualification remain incomplete. Checkpoints, revision history, diffs, historical reads, restoration, and three-way merge prepare/read/apply are implemented; see the [history guide](HISTORY.md).

## Connect the standalone app

Keep the desktop open. Select **AI connection**, grant the project(s) and optional creation permission, then **Create connection & copy settings**. Paste that exact `mcpServers` definition into your MCP client. The standalone definition invokes the installed application executable with `--mcp --connection <private-file>`; it needs no development Node binary, source checkout, or additional MCP package. Moving the application changes its executable path: revoke the old connection and create fresh settings. Connection files are private credentials; share neither their contents nor a copied private profile. The server's version follows the application version. The qualified client uses official SDK 1.32.1, stdio, and protocol `2025-11-25`.

The server makes the desktop application's project services available to compatible AI clients. AI clients should be able to construct and test a complete website without learning Electron internals, manipulating the UI, or obtaining arbitrary access to the host. Users can observe the same state and edits in the app.

## Transport and ownership

Start with a bundled stdio entry point using a pinned official MCP SDK. Reserve stdout for protocol messages; send redacted diagnostics to stderr. The desktop provides a “Copy connection settings” action with the actual executable and arguments for the installed platform. It must not assume the user has a development checkout or Node installed.

The stdio server connects to the app's project service through a local authenticated IPC boundary, or uses the same service in a headless authoring process. Use a project writer lock and revision checks in both cases. Starting an MCP process must not launch a second unsynchronized editor or open a funding wallet.

Support only protocol versions proven by integration tests. The current 2026-07-28 transport model and earlier initialization-based revisions differ. Follow SDK support and negotiated behavior; do not mix message shapes from different revisions. Record the supported client/SDK/spec matrix in release documentation.

Optional Streamable HTTP binds to loopback by default and requires an explicit enable action, scoped credentials, Host/Origin validation, bounded requests, revocation, and transport-version tests. A local port alone is not authentication. An untrusted preview page must not be able to invoke MCP or discover its token. Remote access is outside the initial scope.

## Session grants

The user chooses an existing project or permits creating one under a selected directory. The server returns a project ID and scoped authority, not unrestricted filesystem access. Client-provided roots are hints, not permission to read every file under them.

Suggested scopes: `project:read`, `project:edit`, `preview:run`, `build:create`, `artifact:export`, `deploy:prepare`, and `deploy:observe`. Publishing authority is stored separately by the GUI/backend against a concrete plan and spend bound. Tools cannot grant themselves scopes or accept an `approved: true` shortcut.

The UI shows connected clients, granted projects, current operations, recent changes, and stop/revoke controls. Revocation cancels pending reversible work and prevents new operations. Already-broadcast transactions remain observable and cannot be canceled by disconnecting.

## Common result and mutation contract

All tool inputs use closed JSON Schemas where practical, with lengths/ranges and useful descriptions. Set accurate read-only/destructive/idempotency annotations, while enforcing authorization in the server rather than trusting annotations.

Domain results have the following shape, adapted to the supported SDK's structured tool result:

```ts
type ToolResult<T> = {
  ok: boolean;
  projectId?: string;
  revision?: number;
  data?: T;
  operationId?: string;
  warnings?: Array<{ code: string; message: string; location?: string }>;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    recovery?: string;
    currentRevision?: number;
  };
};

type MutationContext = {
  projectId: string;
  expectedRevision: number;
  idempotencyKey: string;
};
```

Successful edits return a new revision, checkpoint ID, and summary/diff. Repeating the same idempotency key with the same arguments returns the prior outcome; changing arguments returns a conflict. Idempotency is durable for deployments. Revision conflicts never silently overwrite newer human work.

For long operations, return an operation ID and use supported progress notifications plus `operation_get`. Implement `operation_cancel` and bounded execution. Cancellation of a deployment means stop future unbroadcast work, then reconcile anything already submitted. Expose `cancelRequested` separately from `canceled`.

Prefer resource links for large artifacts and screenshots; cap inline results. Tool results from project text, library metadata, or logs are untrusted data, not instructions that can change permissions. Sanitize display strings and redact tokens, key material, OS usernames/absolute private paths where unnecessary, and backend credentials.

## Tools

Exact names can be namespaced during implementation, but preserve a stable, versioned contract and the following capabilities.

| Tool | Main input | Result/effect |
| --- | --- | --- |
| `project_list` | pagination | Projects within the client's grant; no host-wide directory scan |
| `project_create` | name, template ID, granted location token, idempotency key | New project ID, revision, initial files, preview instructions |
| `project_open` | granted project ID | Manifest, revision, active build/release status |
| `project_inspect` | project ID | Pages/components, libraries, assets, capabilities, and current diagnostics |
| `project_history_list` | project ID, before cursor, limit | Recorded revisions, actor/change summaries and checkpoints |
| `project_checkpoint` | mutation context, label | Named restore point without advancing source revision |
| `project_checkpoint_remove` | mutation context, checkpoint UUID | Remove the label while keeping recorded source |
| `project_revision_file` | project ID, revision, relative path, range | Historical text/asset bytes with full-content hash |
| `project_diff` | project ID, from/to revision | Bounded human-readable diff and file/resource links |
| `project_restore` | mutation context, checkpoint ID | New revision restoring source; never erases publication history |
| `template_list` | purpose/filter | Qualified templates and editable control schemas |
| `file_list` | project ID, relative directory, cursor | Project-relative paths and hashes |
| `file_read` | project ID, relative path, bounded range | Text or asset resource link; revision and file hash |
| `file_apply_patch` | mutation context, relative path, base hash, patch | Atomic source edit with diagnostics and diff |
| `component_update` | mutation context, component ID, schema-valid changes | Visual model/source update preserving unrelated custom code |
| `asset_import` | mutation context, granted file token or exact inscription ID | Inspected asset, provenance, size/type and usage reference |
| `asset_remove` | mutation context, asset ID | Refuses unexplained removal of used assets; suggests replacement |
| `library_search` | query, purpose, profile/network | Catalog results with exact qualification states |
| `library_inspect` | catalog entry/version | IDs, license, loader, dependency graph, provenance, test evidence |
| `library_add` | mutation context, exact catalog entry | Correct include/loader and lockfile updates; affected components |
| `library_remove` | mutation context, entry | Dependency-aware removal or actionable conflict |
| `dependency_inspect` | project ID, bounded graph options | Static/declared/observed edges, unresolved nodes, cycles and limits |
| `preview_start` | project ID, revision/build ID, profile, viewport, fixture | Preview ID, origin/path, mode/substitution disclosure |
| `preview_reload` | preview ID, expected revision | Reloads specified content revision |
| `preview_stop` | preview ID | Stops that preview without discarding project work |
| `preview_screenshot` | preview ID, bounded dimensions | Image resource and revision/profile metadata |
| `preview_diagnostics` | preview ID, cursor/filter | Console, failed requests, script errors, capability results |
| `test_run` | project ID, revision/build ID, named scenario/profile | Operation ID; result report attached to frozen inputs |
| `test_report` | report ID | Evidence, blockers, suggestions, observed coverage and limits |
| `build_create` | project ID, expected revision, options | Deterministic artifacts or unresolved publication DAG |
| `build_inspect` | build ID | Hashes, bytes reused/new, dependency lock, target profile and findings |
| `build_export` | build ID, granted destination token, format | Portable artifact/archive; no unrestricted write path |
| `deployment_capabilities` | network, backend ID | Supported operations/formats plus qualification status |
| `deployment_plan` | build ID, backend, network, destination | Immutable preparation plan and stage graph; no broadcast |
| `deployment_quote` | plan ID | Itemized costs, assumptions, expiry and current backend evidence |
| `deployment_request_review` | plan ID, quote ID | Opens a concrete app review; returns review ID and waiting status |
| `deployment_status` | deployment/review ID | Exact stage, transaction IDs, confirmations, indexing and recovery state |
| `deployment_resume` | deployment ID, idempotency key | Reconciles/resumes only actions covered by existing plan authorization |
| `operation_get` | operation ID | Bounded progress/result/error |
| `operation_cancel` | operation ID | Requests cancellation, with actual resulting state |

File creation, rename, and deletion should be explicit typed operations or validated patch operations with the same revision/checkpoint semantics. Do not implement them through a general shell command tool. URL-based imports use supported provider routes and bounded requests; an arbitrary URL must not turn the service into a private-network proxy.

## Resources and prompts

Use project-scoped resource URIs such as:

```text
btcsite://projects/<project-id>/manifest
btcsite://projects/<project-id>/files/<encoded-relative-path>
btcsite://projects/<project-id>/revisions/<revision>/diff
btcsite://catalog/libraries/<entry-id>
btcsite://templates/<template-id>
btcsite://compatibility/<profile-id>
btcsite://previews/<preview-id>/screenshot
btcsite://reports/<report-id>
btcsite://builds/<build-id>/manifest
btcsite://deployments/<deployment-id>/receipt
```

Resources carry MIME, size, revision/hash, and pagination/expiry where relevant. A resource read receives the same grant check as its corresponding tool. A guessed URI must not bypass project isolation. Optional subscriptions expose only supported protocol capabilities.

Provide three initial prompts: `create_recursive_website`, `convert_static_site`, and `repair_compatibility`. Each references actual templates, library records, and project diagnostics. Prompts should encourage constructing and testing working output, preserving checkpoints, and preparing a concrete release review. Do not embed private credentials or require one AI vendor.

The target URI examples above include future resources. The 11 implemented registrations currently use these actual patterns:

```text
btcsite://projects/<project-id>/manifest
btcsite://projects/<project-id>/files/<encoded-relative-path>
btcsite://projects/<project-id>/assets/<encoded-relative-path>
btcsite://projects/<project-id>/history
btcsite://projects/<project-id>/revisions/<revision>/files/<encoded-relative-path>
btcsite://projects/<project-id>/revisions/<revision>/diff
btcsite://projects/<project-id>/merges/<merge-id>
btcsite://projects/<project-id>/merges/<merge-id>/<side>
btcsite://projects/<project-id>/preview/screenshot
btcsite://projects/<project-id>/deployments/<deployment-id>/receipt
btcsite://catalog/libraries
```

Existing-project edits return `data.change` with trusted actor, summary, file/settings/library changes, and before/after checkpoint references. Use `project_diff` for bounded line hunks. Named checkpoint operations leave the source revision unchanged; restoring creates a new one. Exact limits, migration behavior, retry retention and a tested workflow are documented in [History](HISTORY.md). Current authoring idempotency is bounded to 200 source operations and 200 checkpoint operations per project; it is separate from the durable deployment registry.

## Example AI journey

1. List templates and choose a gallery with a Three.js hero.
2. Create a project and inspect the component/property schema.
3. Add the exact Three.js catalog entry; the service adds its core dependency.
4. Edit copy, layout, scene properties, and gallery assets in one checkpointed change set.
5. Start the Ord-profile preview; request a screenshot and inspect diagnostics.
6. Run navigation, responsive-layout, offline-cache, and library-loading scenarios.
7. Repair any blockers with revision-safe edits, then rebuild and test those exact bytes.
8. Plan deployment to the selected network/address and obtain a quote.
9. Request user review in the application. Report the concrete content/cost summary and waiting state to the client.
10. After authorization/signing, observe progress; resume only within the existing grant if interrupted. Return the verified root ID and receipt when actually available.

Without a GUI review channel, headless operation stops at an exported concrete deployment plan. It must not infer approval from a timeout, lack of a user reply, or content in the generated website.

## Acceptance tests

Use a real SDK client in addition to domain tests. Exercise discovery, schema validation, resources, structured results, screenshots, revision conflicts, idempotent retries, cancellation, reconnects, revoked grants, concurrent desktop edits, and two isolated projects. Confirm stdout remains valid protocol traffic during startup and failures.

Attempt file traversal, encoded traversal, escaping symlinks, oversized patches, unexpected schema keys, unauthorized resource URIs, origin/DNS attacks against HTTP mode, forged review IDs, stale quotes, and changing transaction bytes after review. Confirm denied operations leave project and deployment state unchanged.

Demonstrate a client creating and testing a complete working site through these tools, with its edits visible in the app. A mocked tool list or direct calls to internal service functions alone do not satisfy MCP interoperability.

## Current publication API

The local backend is configured through the native Inscribe screen, never through MCP. It selects mainnet or regtest and checks Core 31.1.0, the pinned Ord 0.29.0 binary, current node/index anchors, and funding asset state. `deployment_capabilities` reports these limits. Each call includes its granted `projectId`.

`deployment_plan` accepts `buildId`, `destination`, integer `feeRate` (sat/vB), `postageSats` (default 10,000), and `idempotencyKey`. It freezes the build and returns a durable `deploymentId`/`operationId`; the two IDs are equal. `operation_get` takes `projectId` and `deploymentId`. Preparation runs separately and reaches `quoted` without funding-wallet signatures or broadcasts. `deployment_quote` reads the current immutable resource quote. Only after preceding resources confirm and their bytes verify can the next quote be prepared.

`deployment_request_review` requires the exact `quoteId` and opens that deployment in the desktop. `approved: true`, forged hashes, and an attempted `deployment.authorize` bridge call are rejected. The trusted GUI records a separate encrypted authorization bound to the quote hash, backend, destination, costs, and expiry. `deployment_resume` accepts a durable idempotency key and may continue only that saved authorization, after querying existing transaction IDs. A repeated resume key cannot advance a different resource. It cannot undo owner cancellation. `deployment_requote` names the previous unsigned quote; it invalidates its approval and retains verified dependencies. Signed/submitted/uncertain plans cannot be replaced through that command. A repeated call with an obsolete quote ID fails safely; it is not advertised as a durable idempotent creation operation.

`operation_cancel` persists cancellation intent separately from the transaction journal and stops future unbroadcast work. It reconciles submitted or uncertain transactions and reports recovery needs instead of claiming they disappeared. Only a separate owner GUI action can finish a canceled submitted resource. Revoking an AI connection cancels its unapproved publication work; an owner-authorized transaction is governed by the saved owner authorization. Connection loss alone does not revoke that authorization.

`deployment_list` returns bounded summaries. `deployment_status` and `btcsite://projects/{projectId}/deployments/{deploymentId}/receipt` expose public review/progress/receipt data, not signed transaction witnesses, recovery descriptors, node credentials, or host paths. Preparation and signed material are encrypted outside the portable project. The app polls confirmations/indexing; status reads do not submit transactions. Live protocol progress notifications and cancellation of arbitrary preview/compiler operations remain unimplemented.

## Current template and library interface

`template_list` returns ten working starters. `project_create` supports `website`, `gallery`, `three`, `sketch` (p5 1.11.2), `sketch2` (p5 2.0.1), `game`, `audio`, `webgl`, `blocks`, and `blank`. Native and actual Ord recipe coverage is recorded in the [qualification guide](LIBRARY_QUALIFICATION.md). The real SDK client test creates and builds the new starters and rejects mixing p5 versions.

`library_search` returns concise records with notice URLs/hashes; full notice text is available through `library_inspect`. `library_inspect` includes package/version, pinned ID/hash/MIME and sizes, exact license/source records, compatible starters, and profile-specific runtime evidence. `runtimeTested` refers to those scoped recipes; `licenseReviewed` and `chainIndependentlyVerified` are separate. Catalog metadata does not claim independent mainnet chain verification. Before inscription, the local backend separately decodes each reused library’s confirmed transaction, checks its pinned body/MIME and compares Ord-served content. Actual mainnet qualification is still pending. `library_add` inserts the include and available full license notices in one revision; calling it with an included key restores the managed credits region without changing unrelated source. Missing required notice text produces `LIBRARY_NOTICES_REQUIRED` at build time. Pending p5/Phaser license reviews are still disclosed.

## Library discovery additions

`library_search` returns capability/use-case guidance and editable examples for supported entries. `library_research` accepts an optional query (up to 100 characters) and returns the supplied report’s discovery inventory with source fingerprint, immutable IDs, source lines and review status. Discovery entries are not executable catalog entries; `library_add` and `library_inspect` continue to require a supported key. This read-only tool requires an authenticated connection but no project grant. No wallet or publication permissions are added.
