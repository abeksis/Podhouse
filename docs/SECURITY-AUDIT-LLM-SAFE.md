# Podhouse Security Audit — LLM-Safe Version

**Project:** Podhouse v0.9.0  
**Date:** 2026-09-17 — revised after independent review  
**Type:** LLM-safe redaction — all finding titles, severities, impacts, and remediation guidance preserved; code snippets, exact file paths, line numbers, exploit reproduction steps, and fixture/test evidence removed.

---

## Summary

Podhouse is a self-hosted Docker orchestration platform with a dependency-free Node.js dashboard and a bash CLI. The dashboard is session-gated by default, uses scrypt password hashing and HttpOnly/SameSite=Lax cookies, and holds a read-write Docker socket. A dashboard session therefore carries broad administrative authority. **LAN-only is a deployment assumption, not an enforced listener restriction.**

The revised audit contains **37 numbered entries**, including confirmed issues, source-inspected risks, accepted design constraints and explicitly corrected/withdrawn claims. Entries 1–25 preserve the original remediation-guide IDs; entries 26–34 incorporate the independent review findings, and 35–37 retain additional deployment, revocation and backup observations. The audit's old entries 4/5/6 have been reclassified: **4 = Worker trust model, 5 = security headers, 6 = backup GET claim withdrawn**. These are not 37 confirmed exploitable vulnerabilities.

The highest-priority omissions were plaintext backup copies of secrets/session credentials, cookies shared with apps on other ports of the same hostname, active downloaded SVG content, an unauthenticated request error path, and concurrent auth writes that can undo password changes. Request-body buffering and concurrent login accounting also fail to enforce their intended limits. Release verification remains an important supply-chain improvement, but a same-source checksum sidecar does not establish authenticity.

There are 64 module Compose files. Missing `user:` directives do not establish application UID 0, and media apps do not automatically inherit the dashboard's Docker socket. The previous blanket non-root proposal, backup-GET exfiltration claim, session-pruning claim and `shapeOf()` comment finding have been corrected below. No unconditional critical exploit was established by this review; severity includes the stated attacker prerequisites.

---

## Severity Legend

| Level | Meaning |
|-------|---------|
| **HIGH** | Significant credential compromise, administrative authority, supply-chain execution or availability impact under the stated prerequisites. |
| **MEDIUM** | Bounded abuse, incomplete controls or defense-in-depth gaps requiring remediation. |
| **LOW / OBSERVATION** | Lower-priority hardening, operational constraints, reliability work or corrected/withdrawn findings; not automatically a vulnerability. |

---

## Findings

### HIGH

#### 2. Self-update does not authenticate releases with a pinned signer

**Pattern (generalized):** Release verification relies on HTTPS transport; the updater does not cryptographically verify a release tag against a pinned maintainer signing key. A TODO comment exists where signer verification should occur.

**Impact:** A compromised release source can substitute code subsequently executed with host privileges. HTTPS alone does not protect against compromise of that source.

**Fix:**
1. Provision a real maintainer signing key/fingerprint through a trusted distribution path, defining key rotation and revocation. Never ship placeholder keys as a completed fix.
2. Verify the exact fetched tag object with an isolated trusted keyring or explicit signer allowlist, then check out the verified immutable commit.
3. Fail closed on missing verification tooling, missing/invalid signatures and unauthorized signers. Do not silently skip verification or introduce a default bypass.
4. Test accepted signer, wrong signer, unsigned tag, altered tag, unavailable tooling and offline verification; document the initial trust bootstrap.

---

#### 3. Bootstrap tarball extraction lacks trusted integrity verification

**Pattern (generalized):** The custom tarball path downloads an archive, checks that it can be listed, then extracts it into the installation root. Listing an archive does not authenticate its contents.

**Impact:** A malicious archive supplied through a compromised source can replace the installer and dashboard. User-selected custom sources are an explicit trust decision.

**Fix:**
1. Use the actual named branch in the bootstrap script; require a trusted expected SHA-256 or a signed release manifest before extraction.
2. Download fully to a private temporary directory, validate the expected digest syntax and verify bytes before any extraction or execution.
3. Preserve the current archive layout/strip-components behavior; reject unsafe archive paths/links and stage extraction before publishing the install tree.
4. Fail closed on missing or mismatched verification material. A same-source unsigned checksum detects corruption but does not authenticate a compromised source.
5. Test missing hash, mismatch, truncated download, unsafe archive members and successful extraction. A variable first read in downloaded install.sh is too late.

---

#### 4. Worker install entry point relies on HTTPS-origin trust

**Pattern (generalized):** The install entry point proxies installer content from the main branch of the repository and the documented pipe executes the response as root. Trust therefore rests on the HTTPS serving origins and their administration.

**Impact:** Compromise of the serving worker or upstream repository can replace the script that users execute as root. This assumes a source compromise, not merely ordinary DNS poisoning.

**Fix:**
1. Define and document the trusted distribution root for the first installer/verifier and signing key.
2. Offer a download-then-verify-then-execute flow using a separately trusted key or expected digest. Verification must finish before executing any downloaded code.
3. Serve release-bound artifacts and detached signatures/manifests; test tampered script, wrong signer and missing verification data.
4. Do not rely on an upstream-computed checksum sidecar, ETag, cache header or script self-check to protect against a compromised serving origin. Document remaining HTTPS-origin trust if the one-line pipe is retained.

---

#### 8. Unsafe requests lack explicit Origin/CSRF validation

**Pattern (generalized):** Unsafe endpoints rely primarily on SameSite=Lax and do not validate Origin or a CSRF token. Same-site services on different ports can send authenticated requests, including requests with permissive content types accepted by the body reader as JSON.

**Impact:** A malicious same-site service, especially another port on the dashboard host, can issue authenticated unsafe requests. Distinct LAN IPs are not automatically the same site. JSON parsing accepts permissive content-type bodies and some actions require no body.

**Fix:**
1. Define trusted dashboard origins from configuration, not an unchecked request Host or forwarded header. Apply strict Origin validation and/or session-bound CSRF tokens to unsafe methods.
2. Integrate token creation, retrieval, rotation and expiry with actual session storage. Protect pre-session login/claim with appropriate origin checks and cover logout/password changes.
3. Update every frontend mutation, including streamed module/update/reset/storage requests, and preserve token loading after reload and password rotation.
4. Never expose the session ID as a CSRF token. Validate token type and length before comparison; return controlled errors for malformed tokens.
5. Test same-site different-port attacks, permissive content-type requests, missing/foreign/null origins and invalid tokens.

---

#### 10. Spoofed request-identifier bypasses login throttling

**Pattern (generalized):** The client IP function accepts a forwarded header value without establishing that the TCP peer is a trusted proxy. Direct clients can vary that header on every attempt. Concurrent requests also bypass throttling independently.

**Impact:** A directly connected client can vary the forwarded header to obtain fresh failure budgets. Concurrent requests obtain separate counters before the shared limiter resolves.

**Fix:**
1. Use the actual socket peer address by default; accept forwarded identity only from explicitly configured trusted proxy peers with a defined header-chain policy.
2. Document that the socket peer is the proxy when one is present, not the original client. Review forwarded scheme trust at the same boundary.
3. Test direct spoofed headers, trusted/untrusted proxy peers and malformed forwarded values. Implement concurrent-attempt accounting as part of the complete limiter correction.

---

#### 26. Plaintext backup and credential files expose secrets

**Pattern (generalized):** Self-update saves state and environment files in an unencrypted archive. The archive and its parent directory are created without restrictive permissions under a normal umask, making them world-readable. Staging and restore files use default stream permissions. Per-module backups are permission-hardened only after compression finishes, creating an exposure window. A process crash can leave staging files indefinitely.

**Impact:** A local account able to traverse the install tree can read passwords, backup keys and live sessions in plaintext rollback archives. Staging, restore and late-permission files add exposure windows.

**Fix:**
1. Create backup/staging/restore directories privately at restrictive permissions and files exclusively at restrictive permissions before writing secrets. Apply restrictive shell umasks before archive or credential-file writes.
2. Use unique staging paths, remove failed outputs and publish decrypted data only after successful authentication. Handle abandoned staging files after crashes safely.
3. Secure existing artifacts and directories; decide explicitly whether rollback backups need encryption.
4. Cover platform backups, backup center, per-module backups, restore and setup/credential files. Assess credential/session rotation if unauthorized access to old readable copies was possible.
5. Test under default umask, verify an unprivileged account cannot read files while they are being written, and test corrupt authentication tags and disk failures.

---

#### 27. Dashboard cookies are shared across ports on the same host

**Pattern (generalized):** The session cookie is host-only with path `/`. The default deployment serves the dashboard on one port and apps on other ports of the same hostname. Cookies are not isolated by port. Visiting an app on another port sends the dashboard cookie to that HTTP server too. HttpOnly prevents JavaScript access but does not hide cookies from a receiving server.

**Impact:** A compromised app server on another port of the same hostname can receive the session cookie when the administrator visits it, then replay that cookie against the dashboard.

**Fix:**
1. Configure a dedicated dashboard hostname with host-only cookies and HTTPS. Do not serve unrelated apps on that hostname at other ports.
2. Reject or redirect shared-IP/host aliases before allowing login or setting cookies; document supported proxy/hostname configuration.
3. Expire/migrate old sessions and cookies deliberately. Cookie name changes, path changes or SameSite=Strict are not reliable port isolation.
4. Add Origin/CSRF protection for same-site sibling services. Use a browser fixture to confirm a second app receives no dashboard cookie and cannot forge unsafe requests.

---

#### 28. Downloaded SVG can execute as a dashboard-origin document

**Pattern (generalized):** Remote responses with image content type are cached byte-for-byte and served from the authenticated dashboard origin as SVG, without sanitization or a restrictive document policy. A user who imports an attacker-controlled icon and opens its URL directly can run script with dashboard-origin access.

**Impact:** An imported attacker-controlled SVG can execute authenticated dashboard requests when opened directly or embedded as a document. Normal img rendering does not execute SVG scripts.

**Fix:**
1. Initially reject downloaded SVG and validate accepted raster bytes, or use a maintained sanitization/rasterization implementation. Do not trust Content-Type alone.
2. Alternatively isolate user content on a credential-free origin. Add a restrictive content-specific policy, such as sandbox with `default-src none` and `script-src none`, where applicable.
3. Preserve shipped trusted icons separately and test compatibility. A global script-src self is not a substitute for downloaded-content isolation.
4. Test script-bearing SVG, event handlers, external references, mislabeled content, ordinary img rendering and direct document navigation in a browser.

---

#### 29. Malformed requests escape the server error boundary

**Pattern (generalized):** URL parsing executes before the handler's error boundary. A syntactically invalid request target or Host header throws, rejecting the async listener. There is no top-level rejection handler, and default runtime behavior can terminate the process.

**Impact:** Malformed Host parsing rejects the async listener before error handling. Default unhandled-rejection behavior can terminate the process; repeated requests can defeat restart recovery.

**Fix:**
1. Move URL parsing/validation inside the request error boundary, use a fixed base where Host is unnecessary, and return 400 for invalid request targets/hosts.
2. Await or explicitly catch async response helpers. Attach stream error handlers and account for already-sent headers and disconnected clients.
3. Test malformed Host and request targets in a disposable child server; assert the server remains alive and handles a following valid request.
4. Test files disappearing between stat and streaming, and asynchronous read failures. Do not merely install a global exception handler that leaves request state broken.

---

#### 31. Concurrent auth/state writes can undo credential revocation

**Pattern (generalized):** Auth mutations read the entire auth document, modify a snapshot, and asynchronously replace the file without serialization. An old-credential login overlapping a password change can persist its older snapshot after the new password is saved, restoring the old password hash and old sessions. A logged-in attacker using known old credentials can race an administrator attempting to revoke them. State writers also share temp filenames, causing collisions under concurrent writes.

**Impact:** An old-credential login can overwrite a completed password change with its stale password/session snapshot. Same-process state writes also share a temp filename, producing failures and interference.

**Fix:**
1. Serialize the full read/validate/mutate/write transaction for auth, including password checks and session decisions; coordinate CLI/dashboard writers where they share files.
2. Use unique exclusive private temp files and atomic publication, with error cleanup. Unique filenames alone do not solve stale snapshots.
3. Apply compatible transaction handling to configuration/secret generation and other shared state writers. Define lock failure/crash recovery safely.
4. Add deterministic interleaving tests for login versus password change/logout/claim, and concurrent config/secret writes. Prove old credentials/sessions cannot be restored after revocation.

---

### MEDIUM

#### 5. Security HTTP response headers are missing

**Pattern (generalized):** Response helpers do not set a consistent security-header policy. Headers cover JSON, static assets, authentication, errors and streamed responses inconsistently. The index is served separately from most static-file handling.

**Impact:** Missing frame restrictions allow framing attempts, and absent security policies weaken containment of content mistakes. This is not by itself critical remote code execution.

**Fix:**
1. Set default response headers centrally before routing, covering all response types. Preserve existing cache controls.
2. Add nosniff, a deliberate referrer policy and frame restrictions. Design a content policy around actual script, style, image and connection use.
3. Refactor inline handlers and relevant inline styles rather than broadly enabling script unsafe-inline. Test the full UI before enforcing policies.
4. Give downloaded content its own restrictive policy. Only enable HSTS for a verified HTTPS deployment; trust forwarded scheme headers only from configured proxies.
5. Check header coverage and exercise icon fallbacks, dialogs, inline styling replacements, downloads and streaming operations.

---

#### 9. Privileged operations need bounded work concurrency

**Pattern (generalized):** The server has per-resource in-flight guards, with locking mechanisms for some paths. These do not establish a single bounded budget for all expensive operations or eliminate every overlapping-request race.

**Impact:** An administrator already controls these operations, but accidental or forged bursts can exhaust resources. Existing guards must be accounted for when setting global limits.

**Fix:**
1. Inventory expensive operations and their real routes. Do not rate-limit nonexistent route names.
2. Add measured global concurrency/queue bounds and atomic per-resource locks, integrating with rather than duplicating existing guards.
3. If adding per-session limits, bound/prune their state, return a rate-limit response with Retry-After, and permit ordinary multi-app setup.
4. Test overlapping operations, including error-path lock release.

---

#### 11. Backup restore passes its encryption key in argv

**Pattern (generalized):** The restore function reads the backup key from the environment file in the shell and passes it to the internal Node command as a command-line argument rather than through a protected channel.

**Impact:** A local observer with process-list access can capture the backup key while restore runs, decrypting backups containing box secrets.

**Fix:**
1. Keep the restore command interface; move key reading into the privileged Node restore operation using the correct install root, or pass it through protected stdin/a descriptor.
2. Remove the key from every parent and child argument vector, accounting for sudo behavior. Do not introduce a persistent plaintext key file.
3. Preserve key parsing and error behavior; coordinate with the backup file permission findings.
4. Test with a harmless recognizable fixture key and inspect parent/child argument vectors; verify successful and failed restore behavior.

---

#### 13. Remote icon fetching permits internal network requests

**Pattern (generalized):** The icon fetcher accepts HTTP(S), follows a limited redirect chain, checks content type and byte size, and sets an inactivity timeout. It does not restrict destination addresses or impose a total transfer deadline. Content type checks constrain readable results but do not prevent outbound requests.

**Impact:** Authenticated icon inputs can cause requests to internal services. The content type check limits returned content, so broad metadata exfiltration is not established.

**Fix:**
1. Specify whether private LAN icon sources are supported; enforce an explicit destination policy with narrowly scoped exceptions if needed.
2. Validate IPv4/IPv6/mapped-address ranges and resolve the approved address at connection time while preserving hostname/TLS verification.
3. Revalidate every redirect and prevent DNS rebinding between validation and connection. Add an overall deadline as well as inactivity/size limits.
4. Apply the same content isolation policy from finding #28 to downloaded bytes.

---

#### 18. Module setup passwords are exposed in process arguments

**Pattern (generalized):** VPN and Authelia setup pass passwords to container hashing commands as arguments visible in process listings.

**Impact:** Passwords passed to container commands may appear in host process listings.

**Fix:**
1. Inspect each pinned image/tool for a supported stdin or protected-file password API; use a verified interface.
2. Keep secrets out of host and container argument vectors. Do not assume environment variable passing or shell expansion solves disclosure.
3. If tools lack safe input, choose a compatible controlled hashing implementation and test generated hashes against the actual application.
4. Inspect host/child argument lists using fixture passwords and test failure cleanup.

---

#### 30. Request body rejection does not stop memory growth

**Pattern (generalized):** The body reader appends each chunk and rejects after exceeding a size limit, but leaves its data listener attached and continues appending subsequent chunks. This is reachable on unauthenticated requests.

**Impact:** The body reader continues appending data after rejecting at the intended limit. Unauthenticated requests can retain more input than the documented cap.

**Fix:**
1. Count bytes before retaining chunks and stop retaining data immediately on overflow; send an error response with deliberate bounded drain or connection termination.
2. Handle aborts/errors once, detach obsolete listeners and add a total upload deadline. Decode valid bounded input safely.
3. Test oversized chunked input, misleading/missing content-length, multibyte text, slow uploads and additional chunks after rejection. Assert bounded retained input.

---

#### 32. Concurrent login attempts bypass the failure budget

**Pattern (generalized):** For a previously unseen client, the rate limiter returns a fresh entry without registering it atomically. Concurrent login attempts all receive independent counters instead of sharing one. The limiter state is also never pruned, and synchronous password verification runs on the server's event loop.

**Impact:** For a new client, concurrent attempts obtain separate counters before the shared state resolves. Multiple simultaneous wrong-password attempts can all pass the attempt gate; synchronous verification and unpruned state also affect availability.

**Fix:**
1. Reserve/count attempts synchronously before I/O or password verification and share a registered counter for each identity.
2. Bound/prune limiter state and impose a global verification-concurrency budget; use asynchronous password verification with a bounded queue.
3. Cover login and authenticated password verification with suitable budgets, avoiding trivial permanent account lockout. Integrate trusted-peer handling from finding #10.
4. Test a simultaneous burst from one fresh client, sequential attempts, header rotation, expiry, success handling and saturation recovery.

---

#### 33. Generated modules bypass declared hardening requirements

**Pattern (generalized):** The catalog composer generates services without key security directives. The dashboard writes and installs them without running the validator. The validator checks that keys exist, not that their values enforce the claimed controls.

**Impact:** Generated service Compose files omit key security directives, and the install path does not enforce the validator. Declaring keys alone does not guarantee their security values.

**Fix:**
1. Add compatible generated-service hardening defaults and a shared policy validator used by create/install and CLI paths.
2. Validate actual normalized Compose values, including relevant overrides. Define narrow documented per-service exceptions.
3. Do not blanket-add user directives or accept privileged mode as an automatic escape hatch. Follow image-specific verification from finding #1.
4. Test generated apps, explicit disabled directives, incomplete control dropping, overrides and approved exceptions through real installation validation.

---

#### 34. The final release freeze check fails open

**Pattern (generalized):** If fetching the release control reference fails, or the manifest is empty, execution falls through to the release checkout step. The code comment claims this check fails closed, but the implementation does not enforce that behavior.

**Impact:** Failed control-reference fetch or an empty manifest falls through to checkout despite the fails-closed comment. An earlier check cannot make this later check authoritative.

**Fix:**
1. Stop on control-reference fetch failure, missing/empty manifest, malformed JSON or invalid schema before checkout/migration/install.
2. Enforce freeze status and preserve the verified release identity through execution.
3. Test unavailable control reference, missing manifest, malformed/schema-invalid manifest, frozen release and successful allowed release using disposable test fixtures.

---

### LOW / OBSERVATION

#### 1. Container runtime identity and Docker socket authority

**Status: original UID count withdrawn; architectural observation retained.** There are 64 module Compose files. Images can declare their own runtime user, and entrypoints can drop privileges. The dashboard intentionally runs with Docker socket access. Other apps do not inherit that mount.

**Impact:** A dashboard or socket-holder compromise can control the host. Missing Compose user directives alone do not establish root application processes or a media-container escape.

**Fix:**
1. Inventory each service image, inherited user, entrypoint privilege drop, user ID/group ID support, socket mounts, devices and required capabilities.
2. Choose non-root execution per image and test startup, configuration writes, upgrades and devices.
3. For the dashboard image, design file ownership and runtime socket-group handling before changing user. Retaining the raw socket retains host-root-equivalent authority.
4. Record unknown runtime identities explicitly; verify them on disposable running containers before claiming a count.

---

#### 6. Authenticated backup GET is not a demonstrated CSRF exfiltration

**Status: original exfiltration claim withdrawn.** Triggering a download does not send its response bytes to an attacker. SameSite cookie behavior excludes cross-site image requests from carrying the cookie, and same-origin policy governs response reading even where requests are same-site. Authenticated read-only downloads are valid; sensitive-response caching remains worth tightening.

**Impact:** An image request does not forward downloaded bytes to the attacker. SameSite behavior and same-origin response-reading rules distinguish same-site and cross-site behavior.

**Fix:**
1. Keep the authenticated read-only download contract unless a separate requirement calls for a different method.
2. Add no-store caching to sensitive archive responses and preserve strict filename validation.
3. Test unauthenticated denial, valid authenticated streaming and malformed names.
4. Do not describe a method change as a demonstrated exfiltration fix.

---

#### 7. CLI meta() evaluates fixed expressions

**Status: defense-in-depth refactor, not a confirmed injection.** meta() invokes a scripting engine with fixed expression strings from its callers. Some expressions use fallback values, boolean formatting or key listing, so replacing the evaluation with a safe accessor alone changes behavior.

**Impact:** Current callers use fixed strings. No current user-controlled expression was established.

**Fix:**
1. Inventory every meta() expression, including fallbacks and formatting operations.
2. Replace evaluation with a fixed allowlist of named operations and update all callers together. Preserve output formatting for missing fields.
3. Use real arguments or explicit serialized input.
4. Test list, info and module-scoped secret output, plus malformed metadata.

---

#### 12. Setup scripts receive more secrets than necessary

**Status: least-exposure improvement within a trusted execution boundary.** The composer passes parsed environment values to the fixed setup script. The script already has dashboard privileges and can read the file or use the container runtime directly. Environment filtering helps minimize accidental disclosure but cannot make untrusted scripts safe.

**Impact:** Setup scripts receive the full environment, but already run with privileges sufficient to read that file and use the container runtime. Filtering alone cannot isolate a malicious script.

**Fix:**
1. Inventory container and setup-only environment dependencies. Define an explicit supported schema for needed setup variables.
2. Filter while preserving values containing separators and required inherited runtime variables. Test every affected setup path.
3. Document fixed module-local setup scripts as trusted executable code. Do not claim filtering creates an untrusted-module sandbox.

---

#### 14. Expired sessions are already pruned when sessions are created

**Status: original accumulation claim corrected.** A session-pruning function exists and runs during session creation. Expired sessions are rejected on authentication, and failed login attempts do not create sessions. Optional idle cleanup and active-session limits remain operational improvements.

**Impact:** Failed logins do not create sessions, and creating a session removes expired entries.

**Fix:**
1. Preserve expiry enforcement and the existing pruning helper.
2. If adding cleanup or active-session bounds, persist mutations through the serialized auth transaction.
3. Test expiry, pruning on login, retained current sessions and interaction with logout/password changes.

---

#### 15. Backup download filename validation prevents header injection

**Status: no current header injection found.** The download name accepts only a fixed pattern. Special characters including quotes, newlines and traversal characters cannot reach the download header through this route. Additional encoding is optional defense in depth.

**Impact:** The accepted filename pattern excludes header-injection characters. No current response-splitting path was found.

**Fix:**
1. Retain the strict filename allowlist and validate before setting the download header.
2. Optionally add defensive filename encoding without broadening allowed paths.
3. Test special characters and encoded separators against valid names; do not weaken validation.

---

#### 16. sed-based environment replacement is fragile

**Pattern (generalized):** The environment replacement helper interpolates values into a pattern-matching expression. Current inputs are controlled (version strings, derived keys), but the helper is unsafe for general literal values.

**Impact:** Delimiter, escape and newline handling can corrupt output; current controlled inputs do not establish a remote injection path.

**Fix:**
1. Replace interpolation into pattern expressions with literal-value serialization; validate keys and reject newlines. Preserve comments, unknown values, mode and owner.
2. Use private atomic replacement and handle a single-key file correctly.
3. Test ampersands, delimiters, backslashes, quotes, empty values and rejected newlines.

---

#### 17. Install ownership fallback needs explicit legacy recovery

**Status: normal update ownership regression already addressed.** The install script obtains an existing non-root tree owner before falling back to identity. A legacy tree already owned by root needs a deliberate recovery policy.

**Impact:** The existing code preserves a non-root tree owner. A root-owned legacy installation is ambiguous; guessing the first ordinary account can transfer secrets and privileged scripts to the wrong user.

**Fix:**
1. Preserve the existing non-root-owner path and honor a validated explicit user.
2. For ambiguous root-owned legacy installations, use a verified recorded owner or require an explicit recovery owner. Do not select the first standard user automatically.
3. Test ordinary install, update with no user set, explicit owner and legacy-root cases; preserve module config ownership exemptions.

---

#### 19. shapeOf() comment matches the implementation

**Status: false positive withdrawn; no fix required.** The function replaces digit runs with actual NUL characters, matching its documented behavior.

**Impact:** No issue identified; the implementation and documentation are consistent.

**Fix:** None required.

---

#### 20. Privileged module capabilities should be visible

**Status: accepted capability requiring clear documentation.** Selected modules deliberately request elevated privileges, host networking, devices or socket access. These are different capabilities and should be described accurately.

**Impact:** Elevated privileges, host networking, devices and socket mounts have different effects. A metadata label by itself neither grants nor removes access.

**Fix:**
1. Describe privileges separately in the existing nested metadata; do not create a new top-level metadata key.
2. Connect metadata to validation and installation UI explanations, distinguishing host network, elevated mode, device and socket access.
3. Test schema parsing and UI display, and verify declarations match actual Compose configuration.

---

#### 21. Module-scoped CLI secret display is intentional

**Status: intentional administrative functionality.** The secrets command requires a module, reads its declared variable names and prints those values. It does not dump the complete environment by default.

**Impact:** The secrets command requires a module and prints that module's declared keys. It does not dump every environment value by default.

**Fix:**
1. Preserve module scoping. If masking is desired, design an explicit raw-output option and compatibility behavior.
2. Mask the entire secret by default rather than leaking a fixed prefix; avoid secret values in audit logs.
3. Test that unrelated module secrets never appear and that missing values and explicit raw output behave as documented.

---

#### 22. Inline Node scripts are a maintenance concern

**Status: maintenance observation.** Inline scripts are not intrinsically unsafe when source is fixed and data is passed through arguments. Extraction can improve testing but must preserve behavior.

**Impact:** Inline scripts with safely passed arguments are not intrinsically a security vulnerability.

**Fix:**
1. Extract only where it improves testing or supports concrete fixes, preserving argument, root/environment setup, privilege and output contracts.
2. Exercise the affected CLI commands and existing tests. Prioritize verified security findings over broad extraction.

---

#### 23. meta() suppresses parsing and execution errors

**Status: reliability observation.** meta() discards error output and forces success, potentially hiding broken metadata or failed execution.

**Impact:** Discarding errors and forcing success can hide malformed metadata; no independent privilege escalation was established.

**Fix:**
1. Coordinate with finding #7. Distinguish an absent optional field from a malformed file or failed process.
2. Preserve useful caller diagnostics and safe behavior.
3. Test malformed input, missing optional fields and CLI callers with expected empty output.

---

#### 24. All-container listing is an intentional host-admin feature

**Status: intentional host-admin scope.** The authenticated dashboard exposes unmanaged workloads as well as its own. Container listing returns normalized objects; raw labels are not retained.

**Impact:** The authenticated dashboard intentionally manages and displays host containers, including unmanaged workloads. No separate tenant boundary is implemented.

**Fix:**
1. Keep current behavior unless a managed-only policy is explicitly selected.
2. If narrowing scope, use normalized project identifiers and apply the same policy to listing, logs and actions.
3. Test managed/unmanaged containers and helper logs, with clear UI handling for intentionally hidden workloads.

---

#### 25. Unexpected errors can reveal unnecessary internal detail

**Pattern (generalized):** Error responses to authenticated users can include internal filesystem paths and service response details. Useful operational errors should remain available without exposing sensitive data.

**Impact:** Internal paths and service details can leak through error messages.

**Fix:**
1. Separate validation/expected operational errors from unexpected failures; return safe messages and correlation IDs for the latter.
2. Keep diagnostic detail internally but redact passwords, tokens and sensitive command output before logging.
3. Test filesystem and service failures and verify neither responses nor logs contain fixture secrets.

---

#### 35. LAN access and transport protection are deployment assumptions

**Pattern (generalized):** The published port is not restricted to a LAN address by the application. Plain HTTP permits an on-path observer to obtain credentials/session cookies; exposure depends on routing and firewall configuration.

**Impact:** The published port is not restricted to a LAN address by the application. Plain HTTP permits an on-path observer to obtain credentials/session cookies; exposure depends on routing and firewall configuration.

**Fix:**
1. Document and implement explicit listen/publish-address and trusted-proxy settings appropriate to the supported deployment. Pair with the dedicated HTTPS hostname from finding #27.
2. Verify actual firewall/port exposure, including IPv6 and published ports; do not equate absence of a public proxy route with LAN-only enforcement.
3. Test direct and proxied login, scheme detection and cookie behavior without locking out the documented setup path.

---

#### 36. Open event streams outlive session revocation

**Pattern (generalized):** An existing authenticated server-sent events connection can continue receiving updates after logout, password change or session expiry.

**Impact:** An existing authenticated event stream can continue receiving updates after logout, password change or session expiry.

**Fix:**
1. Define the required revocation latency for event streams. Associate connections with sessions and close on revocation, or periodically revalidate with a documented short bound.
2. Coordinate with auth state serialization and close timers and listeners without leaking resources.
3. Test active streams during logout, expiry and password change; ensure revoked sessions receive no further events after the promised bound.

---

#### 37. Backup success does not establish durable, recoverable application state

**Pattern (generalized):** Archive completion and authentication do not prove successful output-stream completion or consistent live databases.

**Impact:** Archive completion and authentication do not prove successful output-stream completion or consistent live databases.

**Fix:**
1. Wait for successful output-stream completion and handle write errors before encryption/publication. Clean up incomplete files on failure.
2. Define application-specific consistency requirements for live database backups and document what each backup kind guarantees.
3. Test output/disk failures and run restore drills against disposable application data.

---

## Verification and limitations

The independent review used a reproduction harness: all reported reproduction checks completed. The existing test suite reported passing tests. These are prior review results, not evidence that remediation has been implemented. The reproduction harness intentionally asserts current defects; update its expectations as corresponding fixes land.

Tests used harmless temporary fixtures and mocked services, with no real credentials or container changes. A source review cannot establish that no issue remains.

---

## References

- [Remediation guide](SECURITY-FIXES.md) — matching finding numbers and implementation prompts.
- [RFC 6265 §8.5: cookies lack port isolation](https://datatracker.ietf.org/doc/html/rfc6265#section-8.5).
- [MDN: SVG image restrictions versus document navigation](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image).
- [MDN: SameSite cookie behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie) and [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).
- [Node: unhandled exceptions/rejections](https://nodejs.org/api/process.html#event-uncaughtexception).
- [LinuxServer: user/group ID](https://docs.linuxserver.io/general/understanding-puid-and-pgid/) and [non-root container requirements](https://docs.linuxserver.io/misc/non-root/).
