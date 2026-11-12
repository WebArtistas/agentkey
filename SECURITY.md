# Security model

AgentKey 0.1 is a development implementation, **not an audited password manager**. Use test credentials first. Security tests are evidence of specific behavior, not proof of absence of vulnerabilities.

## Intended boundary

The model and its stdio MCP adapter receive item/field names and operation metadata, not secret values. The desktop main process owns the unlocked vault and performs the HTTPS request. Agents may propose an exact request but cannot approve it or replace a saved policy. The narrow local broker cannot unlock or retrieve saved secret values. It can launch an exact local command only after fresh desktop approval; the approved program receives its bound credentials and OS-user privileges, including filesystem and network access. See the separate command boundary below. Approved HTTPS responses may expose selected data to the model/provider; redaction is best-effort, not protection against a malicious or credential-echoing destination.

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

The decrypted vault and key exist in the trusted main process while unlocked. JavaScript strings cannot be reliably zeroized. Key/plaintext buffers are cleared where practical; this does not guarantee erasure from heap copies, swap, crash dumps, OS backups or forensic recovery. No OS keychain unlock, biometric unlock or cloud synchronization is implemented. Managed SQLite snapshots use separate random keys wrapped by the encrypted vault, not an independent OS key store. Losing the master passphrase means losing the vault.

## Use policy

Exact requests are the default: method, URL, fixed JSON or form-encoded body, secret-to-header bindings and selected scalar JSON response paths. HTTP Basic is available for Login items. Transport/routing headers are reserved. Secret header values reject CR/LF and non-ASCII data; Basic encodes the username/password pair. Secret values are not valid configuration in URLs, prefixes or bodies.

Agents can submit an exact request proposal using saved item/field names. Proposals do not authorize I/O or overwrite policies; they are bounded to 32, held in memory for at most ten minutes, deduplicated without replacement, and discarded on lock or affected secret rotation/deletion. Human acceptance validates the displayed random revision and atomically persists policy plus grant. Dismissal, expiry, lock, rotation or name collisions prevent stale acceptance. Request text is untrusted and rendered as text, never HTML.

Only the trusted desktop can add Advanced reusable permissions: the origin of the reviewed URL, explicit HTTP methods and literal paths (optionally ending in `/*` for descendants). Requests may vary query parameters and bodies within these rules, so this is broader authority than repeating an exact request. Authentication, body format and response fields stay fixed. Scheme/host/port changes, path-prefix confusion, encoded paths, backslashes, dot segments, doubled path slashes and extra request fields are rejected. The approved API may interpret query/body data as further destinations or actions: path matching is not an application-level authorization system. Approve restricted upstream credentials and trusted endpoints only.

Only public DNS hostnames over HTTPS on port 443 are accepted. DNS results must all be public unicast addresses. The connection is pinned to a validated address with the original TLS server name and Host header. Certificate verification stays enabled. Redirects, environment proxy settings, cookies and automatic retries are not used.

Without selected response paths, HTTPS remains status-only. With paths, a grant requires explicit data-sharing consent tied to the policy revision and duration. Existing grants without that marker cannot authorize data-returning policies. Only successful, uncompressed JSON responses are collected, bounded to 1 MiB; non-2xx and 204 responses remain status-only. Response headers are never exposed. Projection permits at most 16 scalar paths, eight levels, 100 flattened entries per path, 4 KiB per scalar and 64 KiB output. Whole objects, unsafe path names, malformed JSON, interrupted bodies and oversized content fail closed; failures can occur after upstream side effects.

Selected values redact the used item's values, generated authentication headers and their URL/base64 encodings. This reduces accidental reflection but cannot recognize arbitrary transformations, unrelated sensitive data or covert channels. Returned data is untrusted and may reach any agent/provider; consent cannot recall it later. Never claim strict credential secrecy against a hostile approved API. Temporary byte buffers are cleared where practical, not guaranteed erased from all string/heap copies. URLs and header prefixes are visible configuration; fixed body contents are omitted from agent metadata but available for desktop review, not a substitute for secret fields.

This is direct brokered HTTPS, not system-wide TLS interception or a transparent placeholder proxy for arbitrary programs. No CA certificates or network configuration are installed.

## Database reads

Database reads return approved data, unlike status-only HTTPS operations. Explicit human data-sharing consent is required for every new database grant, bound to the reviewed policy revision and selected duration. The broker rejects database grants without the consent marker, including older saved grants. Status-only API grants are unchanged; data-returning API policies also require consent. Rows may reach any provider or service used by the external agent: AgentKey cannot identify, attest or restrict that destination. File/credential secrecy is not data locality, and revocation cannot recall returned rows. Connections retain one-attempt consumption, revocation and late-result suppression. Agents cannot save database policies, select files, inspect arbitrary schemas, consent or supply SQL.

PostgreSQL uses loopback-only URLs, parameterized reads, read-only transactions and restricted-role checks. SQLite imports a desktop-selected closed/exported file or an in-memory synthetic demo. The desktop-only selection token binds the current unlocked session, inspected bytes and offered column set; it is neither an agent tool nor a grant. The entire database is imported, including unselected columns; only allowed columns may be returned. Original paths are not retained for new managed imports.

SQLite originals are opened only for bounded filesystem reads. Before native parsing, the host rejects sidecars/non-files and WAL-mode images, checks the 16 MiB bound and header, and loads bytes into memory. Size/mtime/ctime are checked across reading; this is not an atomic backup protocol for live databases. Use closed exports. No decrypted database file is written during inspection or reads. Native SQLite deserializes into a memory-only connection in a separate trusted subprocess, with a stripped environment, bounded private pipes, a five-second kill deadline, SQLite's 64 MiB heap limit, disabled extensions, defensive/query-only settings and an authorizer permitting only SELECT and reads of requested allowed columns. The subprocess is resource/error containment, **not an independent OS sandbox**. Views, virtual/shadow tables and generated columns are excluded. No automatic retries occur.

Managed snapshots use AES-256-GCM with a separate random 256-bit key, 96-bit nonce and 128-bit tag. A fixed format/version and random snapshot ID are authenticated as additional data. Keys are stored only inside the encrypted vault, not metadata or renderers. Snapshot ciphertext is atomically written before the vault reference is committed. Ambiguous vault persistence locks the vault and retains the ciphertext rather than deleting a possibly committed dependency. Replacements/deletions remove unused keys from current vault state but may leave encrypted orphan files; no garbage collector or secure-erasure guarantee is provided. Backups require both the vault and snapshot files.

Both connectors bound selected columns/filters, row count and output. SQLite rejects BLOBs and oversized cells. Paths and native errors are not returned. Original files remain unchanged and are not encrypted by AgentKey. Managed reads use the imported bytes until explicit re-import, which revokes grants and review tokens. Existing external-file policies remain external, labelled unencrypted, and continue requiring a valid closed export; no silent conversion/deletion occurs. Their permitted rows may still change when the source changes, like PostgreSQL table rows. Old demo directories and crash remnants from earlier releases are not automatically removed.

AgentKey is a broker, not an agent manager. Users supply their own runtime and isolation. The desktop does not launch the historical Pi/Docker experiments, export their separate broker directory or install host policies. Standard MCP is not OS isolation.

## Approved local command boundary

This connector intentionally expands credential use beyond brokered HTTP and constrained reads. Agents may propose an executable, working directory, argument array, timeout and saved item/field-to-environment bindings. The desktop shows the exact request as untrusted text and requires separate execution and output-sharing consent. A random revision binds the reviewed request; agents cannot approve, override an approved command or obtain a reusable command grant through the API/database approval path.

Commands run as the desktop's OS user, **not in a sandbox**. The approved program and all code it loads are trusted with the raw credentials. It can write files, access other local resources, contact arbitrary destinations and mutate databases. There is no executable/script/dependency integrity pinning, network allowlist or prevention of code substitution by an agent with filesystem access. Human review of an absolute path does not establish the integrity of the program behind it. Do not approve hostile code or advertise this as protection from a compromised approved program. Process arguments can explicitly invoke an interpreter or shell; `shell: false` only prevents implicit shell interpretation by AgentKey.

Input schemas reject extra fields, relative executable/cwd paths, invalid environment names, duplicate bindings, NULs and selected loader/startup variables. Limits: 16 bindings, 64 arguments (4 KiB characters each), 32 simultaneous command requests, eight total active operations, 100 ms–120 seconds per run. The child receives only bound variables and Windows SystemRoot when needed. There is no automatic shell, inherited desktop environment or interactive stdin. Native spawn errors are sanitized. No credentials are put into argv, MCP results or metadata by AgentKey.

Pending/approved commands are ephemeral, expire ten minutes after proposal and are cleared on lock/restart. Rotation/deletion of any bound item invalidates the request. Desktop decisions require the exact revision and state; stale consent cannot reapprove a consumed request. Approval and attempt events are durably audited. Single-use consumption happens synchronously before spawning, so concurrent calls cannot replay it; a persistence failure locks the vault without launching. There is no persistent command policy or grant to restore from an old vault backup.

Stdout/stderr are privately piped and collected up to 64 KiB combined before returning any text. Known bound-item values, common URL/base64/JSON forms and parsed URL credential components are redacted; replacements are not rescanned. Output overflow discards all output and requests cleanup. This is best-effort accidental-disclosure mitigation, not confidentiality against transformed secrets, splitting across streams, timing/exit-code channels or unrelated sensitive data. An approved malicious program can transmit secrets directly elsewhere. The user explicitly consents to sharing output with any connected agent/provider. Buffers are cleared where practical, not all JS strings or child-process memory; output is never deliberately persisted in the activity log.

Abort, lock, revoke, broker disconnect and timeout request cleanup and suppress late output. POSIX uses a process group and Windows uses best-effort process-tree termination. Descendants that detach or race cleanup may survive; no OS containment is claimed. A cleanup deadline prevents hanging on inherited pipes. Termination does not roll back writes, transactions already committed or remote actions. Never automatically retry after a failed, cancelled or ambiguous attempt. Only bounded foreground commands are supported. Windows/macOS command runtime behavior is unverified until tested on those platforms.

## Approval lifecycle

- `wait-for-approval` observes a pending request for at most 45 seconds per call, with at most 16 simultaneous waits. It does not approve, consume a grant or run an operation. Agents may repeat a timed-out wait while the request is pending. Proposals and command requests expire after ten minutes, which ends their waits; for saved-operation access requests the ten-minute limit is agent guidance, not enforced by the broker. Durable approval resolves waiters; dismissal, policy replacement, revocation, expiry, lock and cancellation terminate them. A connection closing releases its waiter. An `approved` result is informational: execution still checks the current grant, so a later revoke or another client consuming a one-attempt grant prevents execution.
- Desktop notifications use fixed generic text without request or credential metadata. Notification clicks navigate to the trusted approval view only. Duplicate requests do not create more alerts, and alerts are throttled. Lock/quit dismisses the held notification; OS delivery/history behavior is platform-dependent.
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
- A malicious/compromised approved API. That endpoint receives the secret, and may encode information into status or timing. Status-only output reduces accidental reflection, not all information channels. Selected-field output with redaction offers less protection and requires explicit consent.
- Per-agent identity, OS process attestation, secure enclave storage, arbitrary subprocess sandboxing or remote-agent authentication.
- Exactly-once side effects, built-in scheduling, rate budgets beyond bounded concurrent requests, trusted time resistant to clock rollback, audit immutability or malicious backup rollback protection.
- Secure deletion, guaranteed zeroization, OS administrator attacks, signed installers, binary integrity enforcement, notarization and automatic updates.
- Browser sessions, OAuth refresh, TOTP, built-in SSH, raw-secret export to an existing agent environment and iOS.

Do not grant a high-privilege permanent credential when a short-lived, narrowly scoped API token will do. Review the action's business impact, not only the secrecy of its password. Use the upstream API's idempotency mechanisms when supported by a fixed operation.

## Reporting a vulnerability

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/WebArtistas/agentkey/security/advisories/new), which is enabled for this repository. Do not include real credentials, vault files or sensitive database contents in reports or public issues. This prototype has no guaranteed response time or audited security release process.
