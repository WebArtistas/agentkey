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
- Guided SQLite demo/file selection and constrained local PostgreSQL reads, with explicit column permissions.
- Seven MCP tools and a portable [agent usage skill](skills/agentkey/SKILL.md).

No raw-secret getter, arbitrary command execution, browser autofill, cloud synchronization, mobile/iOS app, built-in scheduler or account recovery is included. A Login item can authenticate a supported API using HTTP Basic; it does not fill website forms.

## Run from source

Use Node.js **26.13.0 LTS** (see `.nvmrc`) and **pnpm 12.16.1**. Node 24.15+ is also accepted by the dependency stack. Angular 22 requires TypeScript 6.0.x, so this project deliberately does not use TypeScript 7.

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
3. Request access from the agent, then approve the named connection in **Approvals**. Saving a policy does not grant access.
4. A structured read uses schema `main`, table `products`, columns `["id", "name"]` and a limit up to 100. No password or server administration is needed.

**Choose SQLite file** opens a native file picker and inspects schema metadata in the trusted desktop flow. No columns are preselected for your files. Use a closed, exported standalone copy up to 16 MiB: files with WAL/SHM/journal sidecars are rejected. Supported names use ASCII letters/digits/underscores, starting with a letter or underscore. Views, virtual/shadow tables and tables containing generated columns are excluded. Inspection is limited to 128 ordinary tables and 64 columns per table; a saved policy permits at most 32 tables and 16 columns per table.

AgentKey stores the source path as an encrypted vault reference, never in agent metadata. It reads a private temporary copy, not the original, and does not modify or encrypt the selected file. Keep that file in a private location. Moving/deleting it breaks the connection; deleting a policy does not delete the source file. Synthetic demo files are kept beside the vault in their own private directories.

Reads permit only selected columns and AND-equality filters; results are unordered text/null, limited to 100 rows, 4 KiB per cell and 256 KiB per response. BLOBs and oversized results fail closed. **Approved rows can enter the model provider's context. Local SQLite does not mean local inference.** Standard MCP also does not isolate an unrestricted host agent. The experimental Linux Pi runner requires its own passing preflight; this setup neither installs an AppArmor policy nor falls back to non-isolated Pi.

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

Packaged builds use the AgentKey executable with `--mcp --data-dir ...` instead of an external Node process. The desktop panel generates the appropriate command. The desktop vault must already be running. The adapter never launches or unlocks it automatically.

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

**This protects against accidental disclosure to the model, not a hostile program running as your OS user.** Local clients share the same approval scope. Client names are not authenticated identities. Agents with unrestricted shell, filesystem, debugger or desktop-control access are outside this boundary. The experimental Linux Pi runner provides a separate container launch path with a fail-closed preflight, but ordinary MCP configuration does not activate it. Host compatibility, real database integration and live-provider execution need separate verification; do not disable host protections to bypass a failed check.

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

Keep changes small, add regression tests at security boundaries, and never use real credentials in tests, screenshots or issues. `pnpm-lock.yaml` pins dependencies; the two stable `@emnapi` overrides avoid an incompatible optional upstream WASM peer resolution.

## Backup and recovery

Quit AgentKey and back up `vault.json` from the private data directory. The file contains encrypted items, operations, grants and recent audit entries. To restore, quit the app and restore the file to a private AgentKey data directory, then unlock with the original passphrase. SQLite source files are separate: back up any selected exports and saved `sqlite-demo-*` directories too, retaining their location or selecting them again after restoration. `vault.json` encrypts their references, not their contents. Do not copy `agent-connection.json` or socket files. Old backups can restore old approvals, so review/revoke grants after restoring. No master-passphrase change UI is included yet.

## License

[Apache License 2.0](LICENSE). Source: [WebArtistas/agentkey](https://github.com/WebArtistas/agentkey). Product name availability and trademark clearance have not been checked. No signed installer or binary release is published.
