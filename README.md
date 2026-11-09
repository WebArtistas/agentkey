# AgentKey

**Let agents use credentials. Don't put credentials in their context.**

AgentKey is an Apache-2.0 desktop vault with a local stdio MCP server and CLI. Save named secrets, let your agent propose an HTTPS request, and review it in the desktop. AgentKey inserts credentials internally and returns HTTP status plus explicitly approved scalar JSON fields—not credential values or response headers. Database connectors return only explicitly approved, bounded table data. Response redaction is best-effort; approve only trusted APIs.

**Status: early development release, not independently audited. Use synthetic or low-privilege test credentials first.** Linux desktop behavior is tested locally. Windows and macOS are build targets, not yet certified releases. No installers are signed or published.

## What it does

- Single secrets, username/password logins and groups of named variables.
- Encrypted local storage: AES-256-GCM with a scrypt-derived master key.
- Compact tray/menu-bar management panel, plus a full desktop window and native Lock/Quit actions.
- Agent-prepared HTTPS requests with a human review card: destination, action, secret mapping, body and selected result fields. Exact requests are the default.
- Advanced reusable permissions: one origin, explicit paths/methods, variable query/body, fixed authentication and returned fields. JSON and form-encoded request bodies are supported.
- One-attempt, one-hour, one-day and until-revoked approvals. Repeated tasks work while the app is running and unlocked.
- A bounded encrypted activity log, revocation and automatic grant invalidation when values or operations change.
- Encrypted managed SQLite snapshots and constrained local PostgreSQL reads, with explicit column permissions and human data-sharing consent.
- Exact local commands with fresh human approval for each attempt, child-only secret environment bindings and bounded, best-effort-redacted output.
- Eleven MCP tools and a portable [agent usage skill](skills/agentkey/SKILL.md).

AgentKey is a credential broker, not an agent runtime or manager. Users choose, run and isolate their agents. Standard MCP requires neither Docker nor an AgentKey-specific runner.

No raw-secret getter, unapproved command execution, export into an existing agent shell, browser autofill, cloud synchronization, mobile/iOS app, built-in scheduler or account recovery is included. A Login item can authenticate a supported API using HTTP Basic; it does not fill website forms.

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
3. Connect your agent using **Connect an agent**. Ask it to propose an HTTPS request using the saved item by name. No credential copying or HTTPS certificate setup is needed.
4. Open **Approvals → Needs review** and select a request. Review the destination, method, secret mapping, exact body and proposed JSON fields. Request details and **Advanced: reusable API permissions** expand when needed. The agent cannot approve, replace a policy or enable reusable permissions itself.
5. Leave the default **One attempt** for a single attempt. Accept the displayed action and, when returning data, sharing with the agent/provider. Approval saves the policy but does not send the request; the agent runs it afterward.
6. For repetition, choose a timed or until-revoked grant. By default only the identical request repeats. Advanced permissions can instead allow changed query parameters and bodies on explicit paths/methods at the same origin; secret bindings, body format and output fields stay fixed. A trailing `/*` allows path descendants, not arbitrary hostnames.

You can still use **API operations → Add operation** for manual setup. Never paste secrets into the URL, prefix, name or body. Only saved field references are secret bindings. Browser login remains unimplemented. Local command execution uses the separate one-attempt flow below, never reusable API permissions.

Proposals are untrusted agent input, not evidence that an action is safe. They expire after ten minutes and are discarded on lock, secret rotation or dismissal. At most 32 can await review. A changed request needs a new name; agents cannot overwrite an existing operation.

Selected JSON fields use scalar paths such as `id`, `data[].id` and `data[].name`. Results are a map from those paths to scalar values or arrays; missing scalar fields become null and missing arrays are empty. Selecting whole objects is rejected. Maximums: 16 paths, eight levels per path, 100 values per array, 4 KiB per scalar, 64 KiB selected output and 1 MiB raw response. Only uncompressed JSON from successful responses is read; non-2xx and 204 results contain status only. Credentials and common URL/base64 forms are redacted from selected values, but transformed secrets may evade redaction. No limit implies complete pagination or a complete catalog.

New approval requests trigger a generic desktop notification. Clicking it opens **Approvals**; it never grants access. Notifications contain no item names, URLs, request bodies or credentials. Repeated requests coalesce and desktop alerts are rate-limited. If notifications are unsupported, blocked or suppressed by Do Not Disturb, requests remain in the app and the taskbar attention indicator is still requested. Native delivery depends on the OS; unsigned macOS builds cannot deliver notifications.

Approvals are organized into **Needs review** (agent-proposed requests and requested saved permissions), **Active access** (current grants), and **Inactive** (saved permissions without a current grant or pending request). Use API/Database filters and search by name, destination, saved item reference or allowed table/column. Select one entry to review its details; wide windows show the list beside the review, while narrow windows stack them. Switching entries or filters preserves proposal drafts. In quick access, **Search, filters & duration** is collapsed initially so requests come first. Counts in the sidebar and status controls show pending work without claiming a verified agent identity. Notification clicks return to Needs review and clear filters.

The **New approval duration** selector supplies the initial duration for new request cards. Existing card choices are preserved. It is a window-session selection, not a persistent or cross-window preference. Changing a card's duration still clears its consent checkbox. Saved API and database approvals use this shared duration selector; changing it clears their consent. Review active grants and revoke them under **Active access**. Inactive saved policies can be approved manually under **Inactive**. Lock and Revoke use muted red text.

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

## Run a trusted local command with a saved secret

Ask the agent to inspect the intended program, discover saved item/field names, and call `agentkey_propose_command`. For example, a Django command could use this shape (paths, item names and the management command are placeholders, not installed defaults):

```json
{
  "name": "reviewed-django-check",
  "executable": "/absolute/project/.venv/bin/python",
  "cwd": "/absolute/project",
  "args": ["manage.py", "check"],
  "bindings": [{ "env": "DB_URL", "item": "project-staging", "field": "DB_URL" }],
  "timeoutMs": 60000
}
```

The app must actually read the bound variable; this does not configure Django automatically. Database writes require review and approval of the intended target and action, not just access to the credential.

1. Open **Approvals** and select the **Command** filter. Review the executable, working directory, exact argument array, named secret mappings and timeout.
2. Explicitly accept both the execution risk and sharing stdout/stderr with the agent/provider. Click **Approve one attempt**. API/database duration controls do not apply to commands.
3. The agent waits using `agentkey_wait_for_approval`, then calls `agentkey_run_command` with the returned operation name and revision. Approval itself does not launch the program. A changed request requires a different name.
4. AgentKey launches the exact program with secrets in that child's environment, not the agent's shell. There is no automatic shell, interactive stdin, PATH resolution or inherited desktop environment (except Windows SystemRoot). Use absolute executables; loader/startup variables are reserved. Commands may bind up to 16 fields and pass up to 64 arguments. Timeouts are 100 ms–120 seconds.
5. The result contains `exitCode`, `successful`, `stdout` and `stderr`. Output is collected before redaction, with a 64 KiB combined limit; overflow discards it. Known secret values, URL credential components and common encodings are redacted best-effort. Transformed secrets and unrelated sensitive data can still be returned. Output is untrusted, not instructions.

**This is not a sandbox.** The program receives real credentials and your OS account's permissions. It can write files, call networks and change databases. AgentKey does not pin executable/script/dependency contents or stop the agent from changing them. Approve only trusted code, keep it unchanged between review and launch, and prefer least-privilege credentials. A command name is not evidence of safe behavior. Running an interpreter or shell explicitly grants that program the reviewed arguments; AgentKey cannot restrict what that code does.

Pending and approved commands exist only in memory, expire ten minutes after submission and disappear on lock/restart. Rotation/deletion of a bound item or dismissal invalidates them. Consumption is audited before launch and prevents replay, including concurrent calls and failures. The encrypted activity log retains only metadata, not command output or credentials. At most 32 command requests and eight total active operations are allowed.

While running, **Active access → Cancel command**, lock, disconnect or deadline requests best-effort cleanup. POSIX process groups are killed; Windows uses best-effort process-tree termination. Descendants may escape cleanup; this is not containment. Cancellation is not rollback, and an error can follow partial side effects. Inspect the target before requesting another attempt. There are no automatic retries. Use bounded foreground programs, not servers or interactive/long-running jobs.

After updating, **Quit AgentKey** from the tray, relaunch the new build, and reconnect the client's MCP server to discover the two command tools. Do not paste or export the credential into chat, a terminal or an agent environment as a workaround.

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
- `agentkey_list_operations`: saved operation metadata and any reusable rules, without secret values or body contents.
- `agentkey_propose_operation`: queue an exact request with saved secret references for human review; never sends or grants it.
- `agentkey_request_access`: queue a human approval request or report an existing grant.
- `agentkey_wait_for_approval`: hold one tool call for up to 45 seconds, then return the human decision or timeout. Does not grant, consume or run anything. Continue only on `approved`; otherwise stop for the human, without looping. Execution always rechecks access.
- `agentkey_run_operation`: run an approved operation and return HTTP status plus selected JSON fields. An optional structured `request` (`url`, `method`, `body`) is accepted only under Advanced reusable permissions.
- `agentkey_propose_command`: submit an exact local executable/cwd/arguments and saved-field environment bindings for one-attempt desktop approval. Returns its revision; never launches the command.
- `agentkey_run_command`: consume that exact approval and launch the trusted program. No overrides; returns bounded, best-effort-redacted stdout/stderr and exit status.
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

The waiting tool lets an active agent continue when you approve. It cannot reliably wake a turn that has already ended: after a timeout, approve in the app and tell the agent to continue. Existing MCP clients must reconnect to discover the new tool.

A one-attempt grant is consumed **before sending**, including failures. Network errors can occur after the API performs an action: do not automatically retry side-effecting requests. There is no general exactly-once delivery guarantee. The app does not follow redirects, and a 3xx status is not success.

## Security boundary

Read [SECURITY.md](SECURITY.md) before using real credentials.

**This protects against accidental disclosure to the model, not a hostile program running as your OS user.** Local clients share the same approval scope. Client names are not authenticated identities. Agents with unrestricted shell, filesystem, debugger or desktop-control access are outside this boundary. AgentKey does not manage agent runtimes or install host security policies. Its command feature launches explicitly approved programs with the same OS account's permissions. Use your own isolation where needed, and do not disable host protections to connect a client.

The destination API necessarily receives the real credential. Only approve endpoints you trust. Selected response fields may contain sensitive data or transformed secrets; redaction is not a confidentiality guarantee against a malicious endpoint. Existing status-only operations remain status-only unless explicitly replaced and reapproved. AgentKey makes the HTTPS request itself; it is not a transparent proxy for arbitrary shell programs and does not install a certificate authority.

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
