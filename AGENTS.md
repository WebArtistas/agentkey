# AgentKey

## Scope and ownership

Local desktop credential vault with an Electron main process, Angular/Taiga UI,
and a stdio MCP/CLI adapter. Read [README.md](README.md) and
[SECURITY.md](SECURITY.md) before changing behavior. This is an early prototype,
not an independently audited or production-certified password manager.

- `core/` owns vault persistence, approval policy and credential use.
- `desktop/` owns the Electron trust boundary and human approval UI bridge.
- `agent/` owns MCP/CLI transport; `shared/` owns boundary contracts.
- `src/` owns presentation; `tests/` and `e2e/` own verification.
- `skills/agentkey/` describes client usage, not additional agent authority.

## Security constraints

- Keep secrets out of agent responses, logs, screenshots, fixtures and issues.
  Use synthetic credentials and a disposable private data directory for tests.
- Follow the current operation allowlists, output restrictions and approval
  lifecycle in `SECURITY.md`. Do not silently broaden them into arbitrary URLs,
  shell execution, database queries or browser control. New connectors require
  an approved security contract and tests at their trust boundaries.
- Human approval remains in the trusted desktop UI. Local grants are not proof
  of individual agent identity; hostile same-OS-user processes are outside the
  documented boundary. Do not market proposed isolation as implemented security.
- Preserve sandboxing, context isolation, narrow IPC, sender validation and CSP.
  Do not disable Electron's sandbox to make tests pass.
- Cancellation is not rollback. Do not automatically retry side-effecting work
  after an ambiguous network failure.

## Commands and evidence

Use the runtime and pnpm version declared in `.nvmrc` and `package.json`, with
`pnpm-lock.yaml`. From this repository:

- `pnpm test`: core/adapter tests, including stdio MCP integration.
- `pnpm build`: TypeScript and Angular compilation.
- `pnpm test:e2e`: Electron UI checks; on headless Linux use
  `xvfb-run -a pnpm test:e2e`.
- `pnpm format:check`: formatting checks.
- `pnpm package:dir`: unsigned host-platform packaging, only when relevant.

Source, packaged application and platform verification are different evidence.
A configured CI matrix is not proof that Windows or macOS passed. Report exact
checks and gaps; do not infer release readiness from a build.

## Working agreement

Confirm checkout, branch and existing changes; coordinate one writer per file.
Reuse existing contracts and Taiga controls before adding parallel abstractions.
Keep changes bounded and add regression tests for security-sensitive behavior.
Ask about unresolved product/security choices, not facts available in source.
Update existing docs when the contract changes; do not create routine status logs.
Do not stage, commit, push, publish, change credentials or install global agent
configuration without explicit authorization covering the action and target.
