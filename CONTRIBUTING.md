# Contributing

## Development loop

```bash
npm install
npm run verify
npm run dev
```

Keep commits focused. Add protocol fixtures and failure tests before changing navigation grammar, provider normalization, recursive resolution, transaction decoding, or wallet RPC mapping.

## Product rule: no functionality removal

A difficult expert workflow must not be deleted to make the interface appear simpler. Preserve it behind progressive disclosure, a developer panel, an advanced setting, a command, or a dedicated screen. Changes that remove a capability require an explicit architectural decision record, migration plan, and replacement path.

## Boundaries

- Renderer code cannot import Node or Electron modules.
- Provider-specific fields cannot leak into shared navigation/UI contracts without normalization.
- Inscription data must be inserted with DOM text APIs, never remote `innerHTML`.
- Wallet APIs cannot be exposed to inscription frames.
- New IPC handlers require sender validation, payload validation, stable error codes, and tests.
- New recursive endpoints must stay under `/content/*` or `/r/*` unless an audited protocol decision changes that model.
- Managed services cannot use a shell command string.
- All external navigation remains user-mediated.

## Definition of done

A contribution is complete when:

1. Acceptance behavior and error states are specified.
2. Unit tests cover success, malformed input, limits, and failure/fallback behavior.
3. `npm run verify` passes.
4. The packaged application has been smoke-tested on affected platforms.
5. Keyboard operation, focus order, reduced motion, resizing, empty/loading/error states, and high zoom have been checked for UI changes.
6. Security and privacy implications are documented.
7. Migrations preserve existing settings, tabs, bookmarks, history, providers, and advanced capabilities.
8. Documentation and release notes identify operator action.
