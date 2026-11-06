# Security model

AgentKey 0.1 is a development implementation, **not an audited password manager**. Use test credentials first. Security tests are evidence of specific behavior, not proof of absence of vulnerabilities.

## Intended boundary

The model and its stdio MCP adapter receive item/field names and operation metadata, not secret values. The desktop main process owns the unlocked vault and performs the HTTPS request. The narrow local broker cannot unlock, approve, change an operation, retrieve saved secret values, run commands or read arbitrary files.

The full window and compact tray panel are trusted for human entry and approval. They receive values while the user types them, but saved values are not returned to them. Both use sandboxed renderers, context isolation, disabled Node integration and spellchecking, narrow preload functions and exact sender/main-frame/URL validation. Loading the same URL or preload in another window does not grant desktop authority. It never loads remote web pages. Navigation, popups, webviews, permissions, downloads and non-app renderer requests are blocked. The CSP excludes inline JavaScript; inline styles are allowed for Angular/Taiga.

A random 256-bit local capability authenticates broker requests. Unix uses a local socket and 0600 descriptor inside a 0700-created directory; Windows uses a named pipe plus the capability, with filesystem privacy depending on the user's directory ACL. The broker uses bounded frames, connection/time limits and a fixed command schema. No network listener is exposed.

**Approvals apply to all local clients with access to this OS account.** This is not per-agent identity verification. Existing parent directory permissions/ACLs must be private. Do not use a shared data directory.

## At rest and in memory

- AES-256-GCM, random 96-bit nonce per save and 128-bit authentication tag.
- scrypt derives a 256-bit key from the passphrase and random 128-bit salt, with N=131072, r=8, p=1. Parameters are fixed in version 1, not selected by the untrusted vault file.
- Versioned envelope, authenticated application/version identifier, bounded file size and schema validation.
- Atomic temporary-file write and rename, owner-only file mode on Unix, file fsync before rename.
- Items, operations, grants and up to 200 metadata-only activity entries are encrypted together.
- No passphrase, decrypted secrets or response bodies are deliberately logged. Errors crossing the agent boundary are fixed, sanitized messages.

The decrypted vault and key exist in the trusted main process while unlocked. JavaScript strings cannot be reliably zeroized. Key/plaintext buffers are cleared where practical; this does not guarantee erasure from heap copies, swap, crash dumps, OS backups or forensic recovery. No OS keychain unlock, biometric unlock, cloud synchronization or independent key wrapping is implemented. Losing the master passphrase means losing the vault.

## Use policy

Users define an exact method, URL, fixed JSON body and secret-to-header bindings. There are no agent-supplied request arguments. HTTP Basic is available for Login items; other fields can be injected into approved headers. Transport/routing headers are reserved. Secret header values reject CR/LF and non-ASCII data; Basic encodes the username/password pair.

Only public DNS hostnames over HTTPS on port 443 are accepted. DNS results must all be public unicast addresses. The connection is pinned to a validated address with the original TLS server name and Host header. Certificate verification stays enabled. Redirects, environment proxy settings, cookies and automatic retries are not used.

For HTTPS operations, only the status code is returned; response bodies and headers are discarded. URLs and header prefixes are visible configuration, so never put secrets there. Fixed body contents are omitted from agent metadata, but they are not a substitute for secret fields.

## Database reads

Database reads return approved data, unlike status-only HTTPS operations. Rows may reach the agent's inference provider. File/credential secrecy is not a promise that query results stay local. Connections share the existing human grants, revision tokens, one-attempt consumption, revocation and late-result suppression. Agents cannot save policies, select files, inspect arbitrary schemas or supply SQL.

PostgreSQL uses loopback-only URLs, parameterized reads, read-only transactions and restricted-role checks. SQLite uses a desktop-selected closed/exported file, or an app-created synthetic demo. Source references are encrypted as vault items and omitted from all agent metadata. The desktop-only setup token is bound to the current unlocked session and inspected column set; it is neither an agent tool nor an access grant.

SQLite originals are opened only for bounded filesystem reads. Before native SQLite parsing, the host rejects sidecars/non-files, checks the 16 MiB bound and header, and copies into an owner-private temporary directory. Size/mtime/ctime are checked across copying; this is not an atomic backup protocol for live databases. Use closed exports. Native SQLite runs in a separate trusted subprocess, with no inherited provider credentials, a five-second kill deadline, SQLite's 64 MiB heap limit, disabled extensions, defensive/query-only/read-only settings and an authorizer permitting only SELECT and reads of the requested allowed columns. The subprocess is a resource/error-containment measure, **not an independent OS sandbox**. Views, virtual/shadow tables and generated columns are excluded. No automatic retries occur.

Both connectors bound selected columns/filters, row count and output. SQLite rejects BLOBs and oversized cells. Paths and native errors are not returned. The files themselves remain unencrypted in their existing location; synthetic demo files also are not encrypted. Temporary copies are removed during normal completion/cancellation but may remain after a host crash or forced exit. This is not secure deletion; the private directory and OS account boundary still matter. Replacing an approved source can change its permitted rows, just as updating a PostgreSQL table can; the column policy remains enforced on every read.

The experimental Linux Pi runner is separate from this trusted host connector and ordinary MCP. Do not mount database files, the vault or provider auth into the agent container. It must pass its confinement preflight; no policy installation or unrestricted fallback is performed by SQLite setup. Passing a narrow synthetic AppArmor compatibility trial is not certification of the complete isolated Pi/database/provider path.

## Approval lifecycle

- Humans approve in the trusted desktop UI; no agent tool has approval authority. Desktop approval requires the displayed policy's random review token. Policy changes, secret rotation, approval/revocation and locking invalidate stale reviews across the full window and tray panel. Tokens are not hashes of secrets and grant no agent authority.
- Hiding a view masks revealed draft inputs; explicit lock clears drafts in both views. Hiding is not locking, and unfinished drafts remain in the trusted renderer's memory until discarded or locked.
- One-attempt grants are durably consumed before network I/O. A failed or interrupted attempt still consumes them.
- Timed grants are checked before each new request. They do not retroactively undo an already sent request.
- Until-revoked approvals survive restart, but the vault must be explicitly unlocked again.
- Secret rotation, operation replacement and deletion invalidate related grants.
- Revocation and lock abort active requests where possible and suppress late results. A server may already have performed the action; cancellation is not rollback.
- The app locks on supported OS screen-lock/suspend events. Support varies across desktop environments. Closing to tray leaves it unlocked. No idle lock is implemented in this first automation-oriented version.

## Explicit non-goals and limits

- A malicious process or agent with your OS account's filesystem, shell, debugger, accessibility or desktop-control privileges. It could read the broker capability, change source builds, control the approval UI or inspect process memory.
- A malicious/compromised approved API. That endpoint receives the secret, and may encode information into status or timing. Status-only output reduces accidental reflection, not all information channels.
- Per-agent identity, OS process attestation, secure enclave storage, arbitrary subprocess sandboxing or remote-agent authentication.
- Exactly-once side effects, built-in scheduling, rate budgets beyond bounded concurrent requests, trusted time resistant to clock rollback, audit immutability or malicious backup rollback protection.
- Secure deletion, guaranteed zeroization, OS administrator attacks, signed installers, binary integrity enforcement, notarization and automatic updates.
- Browser sessions, OAuth refresh, TOTP, SSH, arbitrary local environment injection and iOS.

Do not grant a high-privilege permanent credential when a short-lived, narrowly scoped API token will do. Review the action's business impact, not only the secrecy of its password. Use the upstream API's idempotency mechanisms when supported by a fixed operation.

## Reporting a vulnerability

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/WebArtistas/agentkey/security/advisories/new), which is enabled for this repository. Do not include real credentials, vault files or sensitive database contents in reports or public issues. This prototype has no guaranteed response time or audited security release process.
