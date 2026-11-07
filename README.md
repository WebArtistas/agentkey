# AgentKey

**Let agents use credentials. Don't put credentials in their context.**

AgentKey is an Apache-2.0 desktop vault with a local stdio MCP server and CLI. You save named secrets, define exact HTTPS operations, and approve their use. For APIs, agents get names and HTTP status—not passwords, API keys, response headers or response bodies. Database connectors return only explicitly approved, bounded table data.

**Status: early development release, not independently audited. Use synthetic or low-privilege test credentials first.** Linux desktop behavior is tested locally. Windows and macOS are build targets, not yet certified releases. No installers are signed or published.

## What it does

- Single secrets, username/password logins and groups of named variables.
- Encrypted local storage: AES-256-GCM with a scrypt-derived master key.
- Compact tray/menu-bar management panel, plus a full desktop window and native Lock/Quit actions.
- Exact saved API operations: public HTTPS on port 443, fixed method/URL/JSON body, secret header bindings or HTTP Basic authentication.
- One-attempt, one-hour, one-day and until-revoked approvals. Repeated tasks work while the app is running and unlocked.
- A bounded encrypted activity log, revocation and automatic grant invalidation when values or operations change.
- Encrypted managed SQLite snapshots and constrained local PostgreSQL reads, with explicit column permissions and human data-sharing consent.
- Seven MCP tools and a portable [agent usage skill](skills/agentkey/SKILL.md).

AgentKey is a credential broker, not an agent runtime or manager. Users choose, run and isolate their agents. Standard MCP requires neither Docker nor an AgentKey-specific runner.

No raw-secret getter, arbitrary command execution, browser autofill, cloud synchronization, mobile/iOS app, built-in scheduler or account recovery is included. A Login item can authenticate a supported API using HTTP Basic; it does not fill website forms.

## Run from source

Use Node.js **26.13.0 LTS** (see `.nvmrc`) and **pnpm 12.16.1**. `pnpm install` installs the pinned project-local Node runtime recorded in the lockfile; it does not replace the system Node installation. SQLite's in-memory import API requires Node 24.16+ or the pinned 26.13 runtime. Angular 22 requires TypeScript 6.0.x, so this project deliberately does not use TypeScript 7.

```sh
pnpm install --frozen-lockfile
pnpm start
```

After building, `pnpm desktop` launches without rebuilding. To keep development data separate:

```sh
pnpm desktop --data-dir /absolute/path/to/private-agentkey-data
```

Electron may download its runtime on first launch. Do not run the app as root or disable Chromium's sandbox. A Linux desktop must support Electron's sandbox; headless UI tests use Xvfb, not `--no-sandbox`.

The source app needs no dev server. It serves only bundled files through a restricted `agentkey://app` protocol. The regular browser has no vault bridge.

## First use

1. Create a vault with a master passphrase of at least 14 characters. There is no recovery service.
2. Add a **Single secret**, **Login**, or **Variable group**. Names are visible to local agents; use non-sensitive labels.
3. Add an **API operation**. Example: name `trigger-backup`, method `POST`, URL `https://api.example.com/v1/backups`, with the item's `value` field bound to `Authorization` and prefix `Bearer `.
4. Add a fixed JSON body if needed. Never paste secrets into the URL, header prefix, name or body: those are configuration, not secret fields.
5. Connect an agent using the **Connect an agent** panel. Let it request access, then approve the exact operation in **Approvals**.
6. Select `until-revoked` or a timed grant for repetitive work. The agent or its scheduler can repeat that operation without further prompts during the grant.

Closing the window normally hides it in the tray and **does not lock the vault**. Lock explicitly when finished. Sleep and OS screen-lock events lock it when Electron/platform support supplies those events. There is no idle auto-lock in this automation-oriented first version. Restarting never silently unlocks the vault. Saved approvals remain, but are unusable until you unlock again.

Replacing an existing item/operation name replaces its definition and revokes associated approvals. Deleting an item deletes its operations too. Deletion is not secure erasure of old disk blocks or backups.

## SQLite: start without a database server

1. Create/unlock the vault, open **Databases**, and choose **Try SQLite demo**.
2. Review the synthetic `products` table. Only `id` and `name` are preselected; `internal_note` stays excluded. Save as `local-demo` or choose another non-sensitive name.
3. Request access from the agent, review the columns and sharing notice in **Approvals**, explicitly accept data sharing, then approve the named connection. Saving an import does not grant access.
4. A structured read uses schema `main`, table `products`, columns `["id", "name"]` and a limit up to 100. No password or server administration is needed.

**Choose SQLite file** opens a native file picker and inspects schema metadata in the trusted desktop flow. No columns are preselected for your files. Use a closed, exported standalone copy up to 16 MiB: WAL-mode images and files with WAL/SHM/journal sidecars are rejected. Supported names use ASCII letters/digits/underscores, starting with a letter or underscore. Views, virtual/shadow tables and tables containing generated columns are excluded. Inspection is limited to 128 ordinary tables and 64 columns per table; a saved policy permits at most 32 tables and 16 columns per table.

AgentKey imports the **entire database** into an encrypted snapshot; the column policy limits what agents can read, not which bytes are imported. Each snapshot has a separate random encryption key stored inside the encrypted vault. Inspection and reads use an in-memory SQLite worker, not a decrypted temporary database file. Demo databases are also created in memory and saved encrypted.

The original file is unchanged and **not encrypted by AgentKey**. Changes to it do not refresh the snapshot, and moving/deleting it does not break the managed connection. To refresh data or allow additional columns, choose the file again and reuse the connection name. The bytes inspected are the bytes saved, even if the original changes during review. Re-importing replaces the policy and revokes its approval. Existing columns can be narrowed through **Edit policy**.

Older file-reference connections remain external and visibly labelled **not encrypted by AgentKey**. They are not silently converted or deleted; re-import explicitly to replace one with a managed snapshot. Old database grants without sharing consent are ignored and must be approved again. API grants are unaffected. Keep original exports and old demo directories private. Encrypted orphan snapshot files may remain after replacement, deletion or interrupted persistence; automatic garbage collection is not implemented.

Reads permit only selected columns and AND-equality filters; results are unordered text/null, limited to 100 rows, 4 KiB per cell and 256 KiB per response. BLOBs and oversized results fail closed. **Approved rows can enter a model provider's context. Local SQLite does not mean local inference.** Consent authorizes sharing the listed data with connected agents for the selected grant duration. AgentKey cannot verify or restrict an external agent's provider or later use of returned data. Revocation cannot recall rows already returned. Ordinary MCP is not OS isolation; that remains the user's responsibility.

PostgreSQL remains available through **Add database**, using a saved loopback URL and a dedicated restricted read-only role.

## Compact quick access

Activate the system-tray/menu-bar icon to open a compact management panel. You can also use **Quick access** in the full window. Linux shells differ: activation may be a click or double-click; the native tray menu includes a **Quick access** fallback.

The panel uses the same vault and controls as the full window. It supports creating/unlocking the vault, adding/replacing/deleting items, defining API operations and database policies, approving/revoking access, viewing activity and reading connection instructions. Navigation and the Lock button stay available while forms scroll. **Full window** opens the larger view; drafts are not transferred between views.

Escape or clicking outside hides the panel. Escape first closes an open choice list. Hiding preserves an unfinished draft but masks revealed values; locking clears drafts in both views. Closing the panel **does not lock the vault or stop approved automation**. Changes in either view invalidate stale approval buttons in the other.

After updating a source build, choose **Quit AgentKey** in the tray and relaunch it. Closing its window alone leaves the previous main process running.

## Connect an agent

One stdio MCP server serves all compatible clients; separate vendor-specific servers are unnecessary. Copy the actual configuration from the desktop app. A source checkout uses:

```json
{
  "mcpServers": {
    "agentkey": {
      "command": "node",
      "args": [
        "/absolute/path/to/agentkey/dist/agent/cli.js",
        "mcp",
        "--data-dir",
        "/absolute/path/shown/in/AgentKey"
      ]
    }
  }
}
```

This is a common configuration shape, not a universal client schema. VS Code uses a `servers` map; clients such as Codex use their own TOML configuration. Pi accepts this `mcpServers` block in its approved project MCP configuration. Follow your installed client's documentation, use absolute paths and restart its MCP connection. Never put a vault passphrase or secret values into client configuration.

Packaged builds use the AgentKey executable as the bundled Node runtime: the generated configuration includes `env: { "ELECTRON_RUN_AS_NODE": "1" }` and the absolute `resources/app.asar/dist/agent/cli.js` path, followed by `mcp --data-dir ...`. Copy the complete configuration from the desktop panel; paths differ by platform. No external Node installation or display server is needed for this adapter. The old desktop `--mcp` entry point is retired—replace old client configurations rather than adding display or sandbox-bypass flags.

The runtime flag belongs only to the adapter's MCP configuration; do not set it globally or on desktop launches. The desktop's renderer sandbox remains enabled. The adapter can start and advertise its tools while AgentKey is closed, but operations require the desktop vault to be running and unlocked. It never launches or unlocks the vault automatically.

Tools:

- `agentkey_status`: initialized/unlocked state.
- `agentkey_list_items`: item names, types and field names.
- `agentkey_list_operations`: fixed operation metadata, without secret values or body contents.
- `agentkey_request_access`: queue a human approval request or report an existing grant.
- `agentkey_run_operation`: run an approved operation and return HTTP status.
- `agentkey_list_databases`: configured connection/column metadata, without source paths or credentials.
- `agentkey_read_database`: approved bounded PostgreSQL/SQLite reads, without raw SQL.

Example prompt: **“Use AgentKey's `trigger-backup` operation. Request access if needed. Do not ask me to paste the API key.”**

The optional `skills/agentkey/SKILL.md` can be loaded by Agent Skills-compatible clients. Review it, then add it through your client's supported skill path. AgentKey does not edit agent configuration or install skills globally.

### CLI fallback

```sh
node dist/agent/cli.js status --data-dir /absolute/private/data-directory
node dist/agent/cli.js list-operations --data-dir /absolute/private/data-directory
node dist/agent/cli.js request-access trigger-backup --data-dir /absolute/private/data-directory
node dist/agent/cli.js run trigger-backup --data-dir /absolute/private/data-directory
```

A one-attempt grant is consumed **before sending**, including failures. Network errors can occur after the API performs an action: do not automatically retry side-effecting requests. There is no general exactly-once delivery guarantee. The app does not follow redirects, and a 3xx status is not success.

## Security boundary

Read [SECURITY.md](SECURITY.md) before using real credentials.

**This protects against accidental disclosure to the model, not a hostile program running as your OS user.** Local clients share the same approval scope. Client names are not authenticated identities. Agents with unrestricted shell, filesystem, debugger or desktop-control access are outside this boundary. AgentKey does not launch agents or install host security policies. Use your own isolation where needed, and do not disable host protections to connect a client.

The destination API necessarily receives the real credential. Only approve endpoints you trust. Status-only responses avoid the common credential-echo problem, but they are not a proof against a malicious endpoint or covert channels.

## Development and verification

```sh
pnpm test             # Node tests, including a real stdio MCP round trip
pnpm build            # strict TypeScript and Angular production build
pnpm peers check      # dependency peer compatibility
pnpm test:e2e         # real Electron desktop, synthetic credentials only
# Headless Linux:
xvfb-run -a pnpm test:e2e
pnpm package:dir      # unsigned host-platform package in release/
pnpm package          # unsigned installer; no publishing
```

The CI workflow targets Linux, Windows and macOS. Adding a workflow is not evidence it has run: do not claim those platforms are verified until the jobs and manual checks pass. Build macOS packages on macOS and Windows packages on Windows. Signing, notarization, automatic updates and distribution are not configured.

Runtime code is in `core/` (vault, policy and networking), `agent/` (MCP/CLI), `desktop/` (Electron trust boundary), `shared/` (contracts), and `src/` (Angular/Taiga UI). Tests live in `tests/` and `e2e/`.

Historical isolated-runner experiments remain under `integrations/pi/` for separate development, not normal setup. The desktop no longer starts or advertises their database-only broker export. Standard MCP remains supported; `pnpm test:pi` includes synthetic SDK checks and native MCP discovery without running a model or Docker.

Keep changes small, add regression tests at security boundaries, and never use real credentials in tests, screenshots or issues. `pnpm-lock.yaml` pins dependencies; the two stable `@emnapi` overrides avoid an incompatible optional upstream WASM peer resolution.

## Backup and recovery

Quit AgentKey and back up **both `vault.json` and the complete `sqlite-snapshots/` directory** from the private data directory. The vault contains encrypted items, policies, grants, snapshot keys and recent audit entries; `.aks` files contain encrypted database snapshots. Either part alone is insufficient to recover managed imports. Restore both together into a private AgentKey data directory with the app stopped, then unlock with the original passphrase. Older external SQLite connections still require their separately managed source files or an explicit re-import. Do not copy `agent-connection.json` or socket files.

Old backups can restore old approvals, including previously accepted sharing consent: review/revoke grants after restoring. Restore hardening, a backup/restore UI and master-passphrase changes are subsequent work, not implemented here. Older app versions cannot read the new snapshot metadata; retain a complete backup before upgrading and do not downgrade a changed vault.

## License

[Apache License 2.0](LICENSE). Source: [WebArtistas/agentkey](https://github.com/WebArtistas/agentkey). Product name availability and trademark clearance have not been checked. No signed installer or binary release is published.
