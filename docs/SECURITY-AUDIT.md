# Podhouse Security Audit

**Project:** Podhouse v0.9.0  
**Date:** 2026-09-17 — revised after independent review  
**Source baseline:** `849b3321e988c71cf75a8fa20a83e9028e9e5609`  
**Scope:** Source review of the CLI, dashboard/server and libraries, browser rendering, install/bootstrap/update/storage scripts, module Compose/setup files, and install Worker. Runtime image identities, browser exploits and deployment controls were not fully tested.

---

## Summary

Podhouse is a self-hosted Docker orchestration platform with a dependency-free Node.js dashboard and a bash CLI. The dashboard is session-gated by default, uses scrypt password hashing and HttpOnly/SameSite=Lax cookies, and holds a read-write Docker socket. A dashboard session therefore carries broad administrative authority. **LAN-only is a deployment assumption, not an enforced listener restriction.**

The revised audit contains **37 numbered entries**, including confirmed issues, source-inspected risks, accepted design constraints and explicitly corrected/withdrawn claims. Entries 1–25 preserve the original remediation-guide IDs; entries 26–34 incorporate the nine independent-review findings, and 35–37 retain additional deployment, revocation and backup observations. The audit's old entries 4/5/6 have been aligned with the guide: **4 = Worker, 5 = headers, 6 = backup GET**. These are not 37 confirmed exploitable vulnerabilities.

The highest-priority omissions were plaintext backup copies of secrets/session credentials, cookies shared with apps on other ports of the same hostname, active downloaded SVG content, an unauthenticated request error path, and concurrent auth writes that can undo password changes. Request-body buffering and concurrent login accounting also fail to enforce their intended limits. Release verification remains an important supply-chain improvement, but a same-source checksum sidecar does not establish authenticity.

There are **64 module Compose files**. Missing `user:` directives do not establish application UID 0, and media apps do not automatically inherit the dashboard's Docker socket. The previous blanket non-root proposal, backup-GET exfiltration claim, session-pruning claim and `shapeOf()` comment finding have been corrected below. No unconditional critical exploit was established by this review; severity includes the stated attacker prerequisites.

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

**Files:** `scripts/self-update.sh:295`; `docs/RELEASING.md`  
**Pattern:** Upstream compromise can deliver root-executed release code

The updater fetches a release tag and checks it out without verifying a signature against a pinned maintainer identity. The verification comment is a TODO. The missing control concerns compromised release infrastructure: ordinary DNS poisoning alone does not bypass HTTPS certificate verification. A completed fix requires real trust material and fail-closed verification, including when tooling is absent.

**Impact:** A compromised release source can substitute code subsequently executed with host privileges; HTTPS alone does not protect against compromise of that source.

**Fix:**

1. Provision a real maintainer signing key/fingerprint through a trusted distribution path and define key rotation and revocation. Never ship placeholder keys as a completed fix.
2. Verify the exact fetched tag object with an isolated trusted keyring or explicit signer allowlist, then check out the verified immutable commit.
3. Fail closed on missing verification tooling, missing/invalid signatures and unauthorized signers. Do not silently skip verification or introduce a default bypass.
4. Test accepted signer, wrong signer, unsigned tag, altered tag, unavailable tooling and offline verification; document the initial trust bootstrap.

---

#### 3. Bootstrap tarball extraction lacks trusted integrity verification

**Files:** `scripts/bootstrap.sh:191–224`  
**Pattern:** Downloaded executable content is extracted before authenticity is established

The custom HB_TARBALL path downloads a tarball, checks that tar can list it, then extracts it into the installation root. Listing an archive does not authenticate its contents. Verification must happen in bootstrap before extraction and execution; adding a variable to the downloaded install.sh cannot establish trust in that installer.

**Impact:** A malicious tarball supplied through a compromised source can replace the installer and dashboard. User-selected custom sources are an explicit trust decision.

**Fix:**

1. Use the actual HB_TARBALL branch in bootstrap.sh; require a trusted expected SHA-256 or a signed release manifest before extraction.
2. Download fully to a private temporary directory, validate the expected digest syntax and verify bytes before any extraction or execution.
3. Preserve the current archive layout/strip-components behavior; reject unsafe archive paths/links and stage extraction before publishing the install tree.
4. Fail closed on missing or mismatched verification material. A same-source unsigned checksum detects corruption but does not authenticate a compromised source.
5. Test missing hash, mismatch, truncated download, unsafe archive members and successful extraction. A variable first read in downloaded install.sh is too late.

---

#### 4. Worker install entry point relies on HTTPS-origin trust

**Files:** `infra/get-worker/src/index.js:36–90`; `scripts/bootstrap.sh`  
**Pattern:** curl-to-root installation lacks independently trusted pre-execution verification

The Worker proxies installer content from GitHub main, and the documented pipe executes the response as root. Trust therefore rests on the HTTPS serving origins and their administration. A checksum computed from the same upstream content, a cache header or an ETag does not establish independent authenticity. An executing script cannot authenticate its own initial execution retroactively.

**Impact:** Compromise of the serving Worker or upstream repository can replace the script users execute as root. This assumes a source compromise, not merely ordinary DNS poisoning.

**Fix:**

1. Define and document the trusted distribution root for the first installer/verifier and signing key.
2. Offer a download-then-verify-then-execute flow using a separately trusted key or expected digest. Verification must finish before sudo bash executes any downloaded code.
3. Serve release-bound artifacts and detached signatures/manifests; test tampered script, wrong signer and missing verification data.
4. Do not claim an upstream-computed SHA-256 sidecar, ETag, cache header or script self-check protects against a compromised serving origin. Document remaining HTTPS-origin trust if the one-line pipe is retained.

---

#### 8. Unsafe requests lack explicit Origin/CSRF validation

**Files:** `dashboard/server.js request/auth/POST handlers`; `dashboard/lib/auth.js`; `dashboard/public/js/app.js`  
**Pattern:** Same-site cross-origin request forgery

Unsafe endpoints rely primarily on SameSite=Lax and do not explicitly validate Origin or a CSRF token. Same-site services on another origin can still send authenticated requests, including text/plain requests accepted by readBody() as JSON. Different IP addresses merely sharing a LAN subnet are not automatically the same site. Session-bound protection must cover streamed mutations and the authentication lifecycle.

**Impact:** A malicious same-site service, especially another port on the dashboard host, can issue authenticated unsafe requests. Distinct LAN IPs are not automatically the same site. JSON parsing accepts text/plain bodies and some actions require no body.

**Fix:**

1. Define trusted dashboard origins from configuration, not an unchecked request Host or forwarded header. Apply strict Origin validation and/or session-bound CSRF tokens to unsafe methods.
2. Integrate token creation, retrieval, rotation and expiry with actual session storage. Protect pre-session login/claim with appropriate origin checks and cover logout/password changes.
3. Update every frontend mutation, including streamed module/update/reset/storage requests, and preserve token loading after reload and password rotation.
4. Never expose the session ID as a CSRF token. Validate token type and length before timingSafeEqual; return controlled errors for malformed tokens.
5. Test same-site different-port attacks, text/plain requests, missing/foreign/null origins according to documented policy, invalid tokens and successful normal workflows.

---

#### 10. Spoofed X-Forwarded-For bypasses login throttling

**Files:** `dashboard/lib/auth.js:267`  
**Pattern:** Untrusted proxy headers control security keying

clientIp() accepts the first X-Forwarded-For value without establishing that the TCP peer is a trusted proxy. Direct clients can change that header on every login attempt. Behind a real proxy, socket.remoteAddress identifies the proxy; original-client forwarding needs an explicit trust policy. Removing spoofable headers does not repair the independent concurrency problem in #32.

**Impact:** A directly connected client can vary X-Forwarded-For to obtain fresh failure budgets. Concurrent requests also bypass throttling independently; see #32.

**Fix:**

1. Use socket.remoteAddress by default; accept forwarded identity only from explicitly configured trusted proxy peers with a defined header-chain policy.
2. Document that socket.remoteAddress is the proxy when one is present, not the original client. Review X-Forwarded-Proto trust at the same boundary.
3. Test direct spoofed headers, trusted/untrusted proxy peers and malformed forwarded values. Implement #32 as part of the complete limiter correction.

---

#### 26. Plaintext backup and credential files expose secrets

**Files:** `scripts/self-update.sh:80,271`; `dashboard/lib/backup.js:113,159,245`; `dashboard/lib/updates.js:433–457`; `homebox:578`; `modules/core/setup.sh`; `modules/portainer/setup.sh`; `scripts/mount-remote.sh`  
**Pattern:** Secret copies are readable before or instead of permission hardening

Self-update permanently saves `state/` and `.env` in an **unencrypted** `state/platform-backups/*.tar.gz`. It creates neither the directory nor the archive with restrictive permissions. Under a normal `022` umask, directories are 0755 and the archive is 0644. A local account that can traverse the install tree can read all passwords, the backup encryption key, and live bearer sessions from `auth.json` inside the tarball. The protected modes of the original files do not protect their bytes inside a readable archive.

Backup Center also creates `.staging-<pid>.tar.gz` with default stream permissions. Restore writes plaintext `archive.tar.gz` with default permissions into a normally readable directory. A failed GCM authentication leaves its partially or fully emitted plaintext file behind. Per-module update backups are chmodded only **after** tar finishes, creating another exposure window. A process crash can leave staging files indefinitely.

**Impact:** A local account able to traverse the install tree can read passwords, backup keys and live sessions in plaintext rollback archives. Staging/restore and write-then-chmod files add exposure windows.

**Evidence:** Fixture verified 0644 rollback/decrypted files under umask 022 and plaintext remaining after failed GCM authentication. Staging and late-chmod exposure are source-inspected.

**Fix:**

1. Create backup/staging/restore directories privately at 0700 and files exclusively at 0600 before writing secrets. Apply restrictive shell umasks before tar or credential-file writes.
2. Use unique staging paths, remove failed outputs and publish decrypted data only after successful GCM authentication. Handle abandoned staging files after crashes safely.
3. Secure existing artifacts and directories; decide explicitly whether rollback backups need encryption. Do not claim all backups are encrypted while platform rollback tars remain plaintext.
4. Cover platform backups, Backup Center, per-module backups, restore and setup/SMB credential files. Assess credential/session rotation if unauthorized access to old readable copies was possible.
5. Test under umask 022, verify an unprivileged account cannot read files while they are being written, and test corrupt authentication tags and disk failures.

---

#### 27. Dashboard cookies are shared across ports on the same host

**Files:** `dashboard/lib/auth.js:145`; `dashboard/lib/modules.js`; `modules/dashboard/docker-compose.yml`  
**Pattern:** Separate app receives dashboard bearer credential

The session cookie is host-only with `Path=/`. The default deployment serves the dashboard at `http://box:8443` and apps at other ports on the **same host**. Cookies are not isolated by port. Visiting `http://box:8096/`, for example, sends the dashboard cookie to that HTTP server too. A compromised app server can capture the cookie header and replay it against the dashboard. HttpOnly prevents JavaScript access; it does not hide cookies from a receiving server. This supplies a concrete app-compromise-to-dashboard escalation missing from audit #1, without pretending media containers mount the dashboard's socket.

**Impact:** A compromised app server on another port of the same hostname can receive hb_session when the administrator visits it, then replay that cookie against the dashboard. HttpOnly does not hide it from receiving servers.

**Evidence:** Standards-backed deployment analysis; no live-browser cookie-capture test was performed.

**Fix:**

1. Configure a dedicated dashboard hostname with host-only cookies and HTTPS. Do not serve unrelated apps on that hostname at other ports.
2. Reject or redirect shared-IP/host aliases before allowing login/claim or setting cookies; document supported proxy/hostname configuration.
3. Expire/migrate old sessions and cookies deliberately. Cookie name changes, path changes or SameSite=Strict are not reliable port isolation.
4. Add #8 Origin/CSRF protection for same-site sibling services. Use a browser fixture to confirm a second app receives no dashboard cookie and cannot forge unsafe requests.

---

#### 28. Downloaded SVG can execute as a dashboard-origin document

**Files:** `dashboard/lib/icons.js:36,113`; `dashboard/server.js:177`  
**Pattern:** Untrusted active content served from an administrative origin

Remote responses labelled `image/svg+xml` are cached byte-for-byte and served from the authenticated dashboard origin as SVG, without sanitization or a restrictive document CSP. A user who imports an attacker-controlled icon and then opens its local URL as a document can run its script with dashboard-origin access, including authenticated API requests. Ordinary `<img>` rendering does **not** execute that script; direct navigation or document embedding is required. The attacker can supply the icon content without knowing the dashboard password.

**Impact:** An imported attacker-controlled SVG can execute authenticated dashboard requests when opened directly or embedded as a document. Normal img rendering alone does not execute SVG scripts.

**Evidence:** Fixture verified script-bearing SVG bytes survive localise() unchanged; direct-navigation execution is based on browser semantics, not a completed browser exploit.

**Fix:**

1. Initially reject downloaded SVG and validate accepted raster bytes, or use a maintained sanitization/rasterization implementation. Do not trust Content-Type alone.
2. Alternatively isolate user content on a credential-free origin. Add a restrictive content-specific policy, such as sandbox with default-src none and script-src none, where applicable.
3. Preserve shipped trusted icons separately and test compatibility. Global script-src self is not a substitute for downloaded-content isolation.
4. Test script-bearing SVG, event handlers, external references, mislabeled content, ordinary img rendering and direct document navigation in a browser.

---

#### 29. Malformed requests escape the server error boundary

**Files:** `dashboard/server.js:732–736,166–220`  
**Pattern:** Unauthenticated availability failure

`new URL(req.url, 'http://' + req.headers.host)` executes **before** the handler's `try`. A syntactically invalid URL host such as `Host: [` throws, rejecting the async HTTP listener. There is no top-level rejection handler. Under the shipped Node 22 default rejection behavior this exits the process; repeated requests can keep it unavailable despite Docker restart.

**Impact:** Malformed Host parsing rejects the async listener before try/catch. Default Node 22 unhandled rejection behavior can terminate the process; repeated requests can defeat restart recovery.

**Evidence:** The actual captured request handler rejected with Invalid URL before authentication/error handling. The fixture caught the rejection rather than crashing a running server.

**Fix:**

1. Move URL parsing/validation inside the request error boundary, use a fixed base where Host is unnecessary, and return 400 for invalid request targets/hosts.
2. Await or explicitly catch async response helpers. Attach stream error handlers and account for already-sent headers and disconnected clients.
3. Test malformed Host and request targets in a disposable child server; assert the server remains alive and handles a following valid request.
4. Test files disappearing between stat and streaming, and asynchronous read failures; do not merely install a global exception handler that leaves request state broken.

---

#### 31. Concurrent auth/state writes can undo credential revocation

**Files:** `dashboard/lib/auth.js:127,217,243`; `dashboard/lib/state-store.js:49`; `dashboard/lib/config.js`; `dashboard/lib/secrets.js`  
**Pattern:** Stale read-modify-write snapshots and colliding temp files

Auth mutations read the entire auth document, modify a snapshot, and asynchronously replace the file without serialization. An old-password login overlapping a password change can persist its older snapshot **after** the new password is saved, restoring the old password hash and old sessions. Similar lost updates affect logout and claim. A logged-in attacker using known old credentials can race an administrator attempting to revoke them.

There is also a lower-level write collision: every write to a given document in one process uses the **same** `.tmp-<pid>` filename. Concurrent writes can fail at rename or interfere with the file being published. Config and secret writers share this pattern, including cross-module installs writing `.env`.

**Impact:** An old-password login can overwrite a completed password change with its stale password/session snapshot. Same-process state writes also share a temp filename, producing rename failures and interference.

**Evidence:** Deterministic auth interleaving restored the old password hash after a completed password change; concurrent real state writes produced ENOENT rename failures.

**Fix:**

1. Serialize the full read/validate/mutate/write transaction for auth, including password checks and session decisions; coordinate CLI/dashboard writers where they share files.
2. Use unique exclusive private temp files and atomic publication, with error cleanup. Unique filenames alone do not solve stale snapshots.
3. Apply compatible transaction handling to .env config/secret generation and other shared state writers. Define lock failure/crash recovery safely.
4. Add deterministic interleaving tests for login versus password change/logout/claim, and concurrent config/secret writes. Prove old credentials/sessions cannot be restored after revocation.

---

### MEDIUM

#### 5. Security HTTP response headers are missing

**Files:** `dashboard/server.js:124,166,177,681`; `dashboard/public/js/app.js:217`  
**Pattern:** Missing browser defense in depth

The response helpers do not set a consistent security-header policy. The index is served through serveIndex(), separately from most static-file handling. The frontend has inline onerror handlers and inline styles, so an untested strict CSP can break functionality. Downloaded content needs additional isolation under #28.

**Impact:** Missing frame restrictions allow framing attempts, and absent CSP/nosniff policies weaken containment of content mistakes. This is not by itself critical remote code execution.

**Fix:**

1. Set default response headers centrally before routing, covering serveIndex, JSON, static assets, streams, authentication and errors. Preserve existing cache controls.
2. Add nosniff, a deliberate referrer policy and frame restrictions. Design a CSP around actual script, style, image and connection use.
3. Refactor inline onerror handlers and relevant inline styles rather than broadly enabling script unsafe-inline. Test the full UI before enforcing CSP.
4. Give downloaded content its own restrictive policy as required by #28. Only enable HSTS for a verified HTTPS deployment; trust forwarded scheme headers only from configured proxies.
5. Check header coverage and exercise icon fallbacks, dialogs, inline styling replacements, downloads and streaming operations.

---

#### 9. Privileged operations need bounded work concurrency

**Files:** `dashboard/server.js:630 and action handlers`; `dashboard/lib/backup.js`; `dashboard/lib/platform.js`  
**Pattern:** Authenticated resource exhaustion and overlapping work

The server has per-module in-flight guards, backups have an in-flight flag and retention, and update paths have locking mechanisms. These do not establish a single bounded budget for all expensive operations or eliminate every overlapping-request race. Limits must match the actual API routes and normal administration workflows.

**Impact:** An administrator already controls these operations, but accidental or forged bursts can exhaust resources. Existing backup in-flight/retention and update locks must be accounted for.

**Fix:**

1. Inventory expensive operations and their real routes, including /api/modules/<id>/<action> and stream variants; do not rate-limit nonexistent route names.
2. Add measured global concurrency/queue bounds and atomic per-resource locks, integrating rather than duplicating existing guards.
3. If adding per-session limits, bound/prune their state, return 429 with Retry-After, and permit ordinary multi-app setup.
4. Test overlapping module installs, backup operations and platform upgrades, including error-path lock release.

---

#### 11. Backup restore passes its encryption key in argv

**Files:** `homebox:565–587`; `dashboard/lib/backup.js`  
**Pattern:** Local process-argument disclosure

cmd_restore() reads HB_BACKUP_KEY from .env in the shell and passes it to its Node command as an argument. The exposure is in that internal call, not a fourth shell argument supplied by the user. Protected stdin/descriptors or direct privileged key reading can preserve the existing command interface.

**Impact:** A local observer with process-list access can capture the backup key while restore runs, decrypting backups containing box secrets.

**Fix:**

1. Keep the restore command interface; move key reading into the privileged Node restore operation using the correct install root, or pass it through protected stdin/a descriptor.
2. Remove the key from every parent and child argv, accounting for sudo behavior. Do not introduce a persistent plaintext key file.
3. Preserve key parsing and error behavior; fix private authenticated output publication under #26.
4. Test with a harmless recognizable fixture key and inspect parent/child argv; verify successful and failed restore behavior.

---

#### 13. Remote icon fetching permits internal network requests

**Files:** `dashboard/lib/icons.js:49–109`  
**Pattern:** Authenticated SSRF / outbound request control

The fetcher accepts HTTP(S), follows a limited redirect chain, checks MIME and byte size, and sets an inactivity timeout. It does not restrict destination addresses or impose a total transfer deadline. MIME checks constrain readable results but do not prevent outbound requests. A lookup followed by an independent connection leaves a DNS-rebinding gap; every redirect needs the same connection-time policy.

**Impact:** Authenticated icon inputs can cause requests to internal services. The MIME check limits returned content, so arbitrary metadata JSON exfiltration is not established. Existing HTTP(S), redirect, size and inactivity limits do not constrain destination addresses.

**Fix:**

1. Specify whether private LAN icon sources are supported; enforce an explicit destination policy with narrowly scoped exceptions if needed.
2. Validate complete IPv4/IPv6/mapped-address ranges and resolve/pin the approved address at connection time while preserving correct hostname/TLS verification.
3. Revalidate every redirect and prevent DNS rebinding between validation and connection. Add an overall deadline as well as inactivity/size limits.
4. Test alternate loopback addresses, ::1, link-local and mapped addresses, public-to-private redirects, rebinding and trickling responses. Apply #28 to downloaded bytes separately.

---

#### 18. Module setup passwords are exposed in process arguments

**Files:** `modules/vpn/setup.sh`; `modules/authelia/setup.sh`  
**Pattern:** Local password disclosure during hashing/setup

VPN and Authelia setup pass passwords to container hashing commands as arguments. Moving a password into docker -e NAME=value still exposes it in host argv, and expanding a protected file into --password exposes the child argv. Input support must be checked for the pinned tool; a guessed stdin interface is not a working fix.

**Impact:** Passwords passed to docker run commands or nested hashing commands may appear in host process listings.

**Fix:**

1. Inspect each pinned image/tool for a supported stdin or protected-file password API; use a verified interface, not a guessed wgpw stdin mode.
2. Keep secrets out of host docker argv and container child argv. docker -e NAME=value and sh -c expansion into --password do not solve disclosure.
3. If tools lack safe input, choose a compatible controlled hashing implementation and test generated hashes against the actual application.
4. Inspect host/child argument lists using fixture passwords and test failure cleanup. Matrix environment passing is not evidence of a safe password-input API.

---

#### 30. Request body rejection does not stop memory growth

**Files:** `dashboard/server.js:712–729`  
**Pattern:** Unauthenticated oversized-body resource exhaustion

`readBody()` appends each chunk and rejects after `data.length > 16384`, but leaves its data listener attached and continues appending subsequent chunks. This is reachable on unauthenticated login/claim requests. Sending an oversized body can consume memory beyond the intended limit; the limit also counts decoded string units, not incoming bytes.

**Impact:** readBody continues appending data after rejecting at 16384 string units. Login/claim requests can retain more input than the documented cap.

**Evidence:** After the actual function rejected, another fixture chunk was still consumed by its data listener.

**Fix:**

1. Count bytes before retaining chunks and stop retaining data immediately on overflow; send 413 with deliberate bounded drain or connection termination.
2. Handle aborts/errors once, detach obsolete listeners and add a total upload deadline. Decode valid bounded input safely.
3. Test oversized chunked input, misleading/missing Content-Length, multibyte text, slow uploads and additional chunks after rejection. Assert bounded retained input.

---

#### 32. Concurrent login attempts bypass the failure budget

**Files:** `dashboard/lib/auth.js:178–235`  
**Pattern:** Non-atomic rate accounting and unbounded verification work

For a previously unseen IP, `rateLimit()` returns a fresh entry without putting it into the Map. Login then awaits `read()`. Concurrent requests all receive independent counters; each later failure writes its own count of one. The Map is also never pruned, and synchronous scrypt runs on the server's event loop. Spoofed XFF makes both brute force and Map growth easier, but removing XFF alone leaves the concurrency defect.

**Impact:** For a new IP, concurrent attempts obtain separate counters before read() resolves. Twenty wrong-password attempts can all pass the eight-attempt gate; synchronous scrypt and unpruned limiter state also affect availability.

**Evidence:** Twenty simultaneous wrong-password requests from one fixture IP all returned 401 rather than reaching the eight-attempt lockout; another attempt was still verified.

**Fix:**

1. Reserve/count attempts synchronously before I/O or password verification and share a registered counter for each identity.
2. Bound/prune limiter state and impose a global verification-concurrency budget; use asynchronous scrypt with a bounded queue.
3. Cover claim/login and authenticated password verification with suitable budgets, avoiding trivial permanent account lockout. Integrate trusted-peer handling from #10.
4. Test a simultaneous burst from one fresh IP, sequential attempts, rotating spoofed headers, expiry, success handling and saturation recovery.

---

#### 33. Generated modules bypass declared hardening requirements

**Files:** `dashboard/lib/catalog.js:169`; `dashboard/lib/compose.js:169`; `homebox:623`  
**Pattern:** Missing defaults and validation of key presence rather than values

`composeFor()` generates services without `security_opt: no-new-privileges` or `cap_drop: ALL`. The dashboard writes and installs them without running the CLI validator. The validator itself checks that those **keys exist**, not that their values enforce the claimed controls. The audit's assertion that every module is subject to enforced hardening is therefore inaccurate.

**Impact:** Generated app Compose files omit no-new-privileges and cap_drop: ALL, and the dashboard install path does not enforce the CLI validator. Declaring keys alone does not guarantee their security values.

**Evidence:** Source-inspected generation/install and validator paths; no live-image compatibility test was performed.

**Fix:**

1. Add compatible generated-service hardening defaults and a shared policy validator used by create/install and CLI paths.
2. Validate actual normalized Compose values, including relevant overrides, not just matching key names. Define narrow documented per-service exceptions.
3. Do not blanket-add user: or accept privileged: true as an automatic escape hatch. Follow image-specific verification in #1.
4. Test generated apps, explicit disabled no-new-privileges, incomplete capability dropping, overrides and approved exceptions through real installation validation.

---

#### 34. The final release freeze check fails open

**Files:** `scripts/self-update.sh:314–329`  
**Pattern:** Unavailable release-control data does not stop checkout

If fetching `main:refs/remotes/origin/hb-control` fails, or the manifest is empty, execution falls through to checkout. The comment explicitly says this check fails closed. The dashboard normally does an earlier check, but that does not make this final check authoritative, and the CLI permits an explicit target.

**Impact:** Failed control-ref fetch or an empty manifest falls through to checkout despite the fails-closed comment. An earlier dashboard check cannot make this later check authoritative, and explicit CLI targets also exist.

**Evidence:** Source-inspected failed-fetch/empty-manifest branches; no live release update was executed.

**Fix:**

1. Stop on control-ref fetch failure, missing/empty manifest, malformed JSON or invalid schema before checkout/migration/install.
2. Enforce freeze: true and preserve the immutable verified release identity from #2 through execution.
3. Test unavailable control ref, missing manifest, malformed/schema-invalid manifest, frozen release and successful allowed release using disposable git fixtures.

---

### LOW / OBSERVATION

#### 1. Container runtime identity and Docker socket authority

**Files:** `dashboard/Dockerfile`; `modules/*/docker-compose.yml`; `docs/DOCKER-SOCKET.md`  
**Pattern:** Unverified runtime UID claims; root-equivalent Docker access

**Status: original UID count withdrawn; architectural observation retained.** There are 64 module Compose files. Images can declare USER themselves, and root entrypoints can drop privileges through PUID/PGID or image-specific settings. The dashboard intentionally runs as root with Docker socket access. Other apps do not inherit that mount. Runtime identities need image-specific inspection and tests before changing user settings.

**Impact:** A dashboard or socket-holder compromise can control the host. Missing Compose user directives alone do not establish root application processes or a media-container escape.

**Fix:**

1. Inventory each service image, inherited USER, entrypoint privilege drop, PUID/PGID support, socket mounts, devices and required capabilities.
2. Choose non-root execution per image and test startup, config writes, upgrades and devices. Do not blanket-add user: or exempt arbitrary privileged services.
3. For the Alpine dashboard image, design file ownership and runtime socket-group handling before changing UID. A fixed build-time GID is not portable. Retaining the raw socket retains host-root-equivalent authority.
4. Record unknown runtime identities explicitly; verify them on disposable running containers before claiming a count.

---

#### 6. Authenticated backup GET is not a demonstrated CSRF exfiltration

**Files:** `dashboard/server.js:1111`; `dashboard/public/js/app.js:1454`  
**Pattern:** Original exfiltration claim withdrawn

**Status: original CSRF-exfiltration claim withdrawn.** Triggering a download does not send its response bytes to an attacker. SameSite=Lax excludes cross-site image requests from carrying the cookie, and same-origin policy governs response reading even where requests are same-site. Authenticated read-only GET downloads are valid; sensitive-response caching remains worth tightening.

**Impact:** An image request does not forward downloaded bytes to the attacker. SameSite=Lax blocks cross-site image cookies; same-site behavior and same-origin response-reading rules must be distinguished.

**Fix:**

1. Keep the authenticated read-only download contract unless a separate product requirement calls for POST.
2. Add Cache-Control: no-store to sensitive archive responses and preserve strict filename validation.
3. Test unauthenticated denial, valid authenticated streaming and malformed names. If choosing POST, add the #8 CSRF defense, check response status and account for large-archive Blob memory cost.
4. Do not describe GET-to-POST conversion as a demonstrated exfiltration fix.

---

#### 7. CLI meta() evaluates fixed expressions

**Files:** `homebox:57–75 and meta() callers`  
**Pattern:** Latent maintenance hazard; no current user-controlled expression identified

**Status: defense-in-depth refactor, not a confirmed injection.** meta() invokes node with fixed expression strings from its callers. Some expressions use fallback values, boolean formatting or Object.keys(), so replacing eval with a dot-path accessor alone changes behavior. No current user-controlled expression was established.

**Impact:** Current callers use fixed strings. The audit did not establish an injectable expression or privileged eval exploit.

**Fix:**

1. Inventory every meta() expression, including fallbacks, theme access, boolean formatting and Object.keys(m.env_vars || {}).
2. Replace eval with a fixed allowlist of named operations and update all callers together. Preserve array/newline and missing-field output.
3. Use real arguments or explicit serialized input; do not refer to an undefined tmpfile. meta() currently invokes node, not node_root.
4. Test list, info and module-scoped secrets output, plus malformed metadata. Coordinate error handling with #23.

---

#### 12. Setup scripts receive more secrets than necessary

**Files:** `dashboard/lib/compose.js:117–166`; `modules/*/setup.sh`  
**Pattern:** Secret minimization within an already privileged trust boundary

**Status: least-exposure improvement within a trusted execution boundary.** compose.js passes parsed .env values to the fixed modules/<id>/setup.sh script. The script already has dashboard privileges and can read the file or use Docker directly. Filtering environment variables helps minimize accidental disclosure but cannot make malicious setup scripts safe.

**Impact:** Setup scripts receive the full .env, but already run with privileges sufficient to read that file and use Docker. Environment filtering alone cannot isolate a malicious script.

**Fix:**

1. Inventory container and setup-only environment dependencies, including paths and identity. Define an explicit supported schema for needed setup variables.
2. Filter in compose.js while preserving values containing equals signs and required inherited runtime variables. Test every affected setup path.
3. Document fixed module-local setup.sh as trusted executable code. Do not claim filtering creates an untrusted-module sandbox; that needs filesystem and Docker authority isolation.

---

#### 14. Expired sessions are already pruned when sessions are created

**Files:** `dashboard/lib/auth.js:119–133,169`  
**Pattern:** Original unbounded-expired-session claim corrected

**Status: original accumulation claim corrected.** pruneSessions(sessions) exists in auth.js and runs during createSession(). Expired sessions are rejected on authentication, and failed login attempts do not create sessions. Optional idle cleanup and active-session limits should use the serialized auth transaction from #31.

**Impact:** Failed logins do not create sessions, and creating a session removes expired entries. Optional active-session bounds and idle cleanup remain operational improvements.

**Fix:**

1. Preserve expiry enforcement and the existing pruneSessions(sessions) helper in auth.js.
2. If adding cleanup or active-session bounds, persist mutations through the serialized auth transaction from #31. Do not call an invented state-store helper or pass no sessions argument.
3. Test expiry, pruning on login, retained current sessions and interaction with logout/password changes.

---

#### 15. Backup download filename validation prevents header injection

**Files:** `dashboard/lib/backup.js:NAME_RE and resolveName()`; `dashboard/server.js:1111–1121`  
**Pattern:** Original exploitable-header claim withdrawn

**Status: no current header injection found.** resolveName() accepts only the fixed homebox-(config|full)-timestamp.tar.gz.enc pattern. Quotes, CR/LF, backslashes and traversal characters cannot reach Content-Disposition through this route. Additional encoding is optional defense in depth and must preserve the strict path allowlist.

**Impact:** The accepted filename pattern excludes quotes, CR/LF, backslashes and path traversal. No current response-splitting path was found.

**Fix:**

1. Retain the strict backup filename allowlist and validate before setting Content-Disposition.
2. Optionally add defensive filename encoding without broadening allowed filesystem paths.
3. Test quotes, CR/LF, encoded separators and valid archive names; do not weaken validation in the name of escaping.

---

#### 16. sed-based environment replacement is fragile

**Files:** `install.sh:env_force()`; `modules/metrics/setup.sh`  
**Pattern:** Controlled-value replacement hazard

env_force() interpolates replacement values into a sed expression, and metrics setup has a related pattern. Current version and derived-key inputs are controlled, but the replacement helper is unsafe for general literal values. A replacement must preserve permissions, reject newlines and handle a file whose only line is removed; grep -v returns 1 in that valid empty-output case.

**Impact:** Delimiter, ampersand and newline handling can corrupt replacement output; current controlled version/derived-key inputs do not establish a remote injection path.

**Fix:**

1. Replace interpolation into sed programs with literal-value serialization; validate keys and reject CR/LF. Preserve comments, unknown values, mode and owner.
2. Use private atomic replacement and handle a single-key file/empty filtered output correctly. grep -v exit 1 is not necessarily an error; awk -v also interprets escapes.
3. Test ampersands, delimiters, backslashes, quotes, empty values, only-line replacement and rejected newlines.

---

#### 17. Install ownership fallback needs explicit legacy recovery

**Files:** `install.sh:42–47,230`; `scripts/self-update.sh:chown_back()`; `dashboard/lib/storage.js:onHostDetached()`  
**Pattern:** Normal non-root-owner path already fixed

**Status: normal update ownership regression already addressed.** install.sh first obtains an existing non-root tree owner before falling back to explicit/sudo/current-user identity. A legacy tree already owned by root needs a deliberate recovery policy. Selecting the first UID >=1000 is not proof of ownership and could grant the wrong account access to secrets and executable scripts.

**Impact:** The existing code preserves a non-root tree owner. A root-owned legacy installation is ambiguous; guessing the first ordinary account can transfer secrets and root-executed files to the wrong user.

**Fix:**

1. Preserve the existing non-root-owner path and honor a validated explicit HB_USER.
2. For ambiguous root-owned legacy installations, use a verified recorded owner or require an explicit recovery owner. Do not select the first UID >=1000.
3. Test ordinary sudo, nsenter with no SUDO_USER, explicit owner and legacy-root cases; preserve module config ownership exemptions.

---

#### 19. shapeOf() comment matches the implementation

**Files:** `dashboard/lib/versions.js:27–28`  
**Pattern:** False positive withdrawn

**Status: false positive withdrawn; no fix required.** shapeOf() replaces digit runs with actual NUL characters, matching its comment. It returns a string, not an object mapping property names to true. The isolated fixture verified its exact output.

**Impact:** The function returns a string whose digit runs are NUL placeholders. It does not remove the digits without a placeholder or return an object of property names.

**Fix:**

1. Make no implementation or comment change for the original claim.
2. Retain the exact-output fixture confirming shapeOf("v1.6.0-ls362") has NUL placeholders; preserve version comparison behavior.

---

#### 20. Privileged module capabilities should be visible

**Files:** `modules/homeassistant/docker-compose.yml`; `modules/coolercontrol/docker-compose.yml`; `other host-access modules`; `docs/MODULE-SCHEMA.md`  
**Pattern:** Accepted host access needs accurate metadata

**Status: accepted capability requiring clear documentation.** Selected modules deliberately request privileged mode, host networking, devices or socket access. These are different capabilities and should be described accurately. Any metadata belongs inside the existing x-homebox mapping and needs validation/UI integration to influence behavior.

**Impact:** Privileged mode, host networking, devices and socket mounts have different effects. A label by itself neither grants nor removes access.

**Fix:**

1. Describe privileges separately in the existing nested x-homebox metadata; do not create a literal top-level x-homebox.privileged key.
2. Connect metadata to validation and installation UI explanations, distinguishing host network, privileged mode, device and Docker socket access.
3. Test schema parsing and UI display, and verify declarations match actual Compose configuration.

---

#### 21. Module-scoped CLI secret display is intentional

**Files:** `homebox:519–528`  
**Pattern:** Explicit administrative secret access

**Status: intentional administrative functionality.** cmd_secrets() requires a module, reads its declared variable names and prints those values. It does not dump the complete .env by default. Masking and explicit raw output are optional interface changes; preserving module scope is essential.

**Impact:** homebox secrets requires a module and prints that module’s declared keys. It does not dump every .env value by default.

**Fix:**

1. Preserve module scoping. If masking is desired, design an explicit raw-output option and compatibility behavior.
2. Mask the entire secret by default rather than leaking a fixed prefix; avoid secret values in audit logs.
3. Test that unrelated module secrets never appear and that missing values and explicit raw output behave as documented.

---

#### 22. Inline Node scripts are a maintenance concern

**Files:** `homebox`; `modules/metrics/setup.sh`  
**Pattern:** Readability/testing improvement, not a demonstrated injection

**Status: maintenance observation.** Inline node -e scripts are not intrinsically unsafe when source is fixed and data is passed through argv. Extraction can improve testing, but must preserve root selection, environment, privilege and output behavior. It should support concrete fixes rather than displace them.

**Impact:** Inline JavaScript with safely passed argv is not intrinsically a security vulnerability.

**Fix:**

1. Extract only where it improves testing or supports concrete fixes, preserving argv, root/environment setup, privilege and output contracts.
2. Exercise the affected CLI commands and existing YAML tests. Prioritize verified security findings over broad extraction.

---

#### 23. meta() suppresses parsing and execution errors

**Files:** `homebox:57–75`  
**Pattern:** Reliability/error-reporting concern

**Status: reliability observation.** meta() discards stderr and forces success, potentially hiding broken metadata or failed Node execution. Changing this under set -e requires checking all callers and distinguishing optional missing fields from malformed input. Coordinate with the explicit-operation refactor in #7.

**Impact:** Discarding stderr and forcing success can hide malformed metadata; no independent privilege escalation was established.

**Fix:**

1. Coordinate with #7. Distinguish an absent optional field from a malformed file or failed Node process.
2. Preserve useful caller diagnostics and safe behavior under set -e; avoid snippets using nonexistent meta.js/tmpfile variables.
3. Test malformed YAML, missing optional fields and CLI callers with expected empty output.

---

#### 24. All-container listing is an intentional host-admin feature

**Files:** `dashboard/server.js:/api/containers and container/log routes`; `dashboard/lib/docker.js:listContainers()`  
**Pattern:** Original unauthorized-disclosure characterization corrected

**Status: intentional host-admin scope.** The authenticated dashboard exposes unmanaged workloads as well as its own. docker.listContainers() returns normalized objects with a project field; raw Docker Labels are not retained. A narrower policy would need consistent enforcement on logs/actions as well as listing.

**Impact:** The authenticated dashboard intentionally manages and displays host containers, including unmanaged workloads. No separate tenant boundary is implemented.

**Fix:**

1. Keep current behavior unless a managed-only policy is explicitly selected.
2. If narrowing scope, use normalized c.project, not nonexistent c.Labels, and apply the same policy to listing, logs and actions.
3. Test managed/unmanaged containers and helper logs, with clear UI handling for intentionally hidden workloads.

---

#### 25. Unexpected errors can reveal unnecessary internal detail

**Files:** `dashboard/server.js catch blocks`; `dashboard/lib/docker.js`  
**Pattern:** Authenticated diagnostic exposure

Unexpected errors can include internal filesystem paths and daemon response details. Expected validation and operational errors remain useful to the authenticated administrator. Redaction must cover server logs as well as client responses; copying arbitrary Docker output into console.error can simply move a secret disclosure.

**Impact:** Internal paths and daemon details can leak through error messages. Useful authenticated operational errors should remain available without exposing secrets.

**Fix:**

1. Separate validation/expected operational errors from unexpected failures; return safe messages and correlation IDs for the latter.
2. Keep diagnostic detail internally but redact passwords, tokens and sensitive command output before logging.
3. Test filesystem and Docker failures and verify neither responses nor logs contain fixture secrets. Resolve unhandled failures under #29 first.

---

#### 35. LAN-only access and transport protection are deployment assumptions

**Files:** `dashboard/server.js:server.listen()`; `modules/dashboard/docker-compose.yml:ports`; `docs/SECURITY.md`  
**Pattern:** All-interface HTTP exposure requires explicit operational controls

The published port is not restricted to a LAN address by the application. Plain HTTP permits an on-path observer to obtain credentials/session cookies; exposure depends on routing and firewall configuration.

**Impact:** The published port is not restricted to a LAN address by the application. Plain HTTP permits an on-path observer to obtain credentials/session cookies; exposure depends on routing and firewall configuration.

**Fix:**

1. Document and implement explicit listen/publish-address and trusted-proxy settings appropriate to the supported deployment. Pair with the dedicated HTTPS hostname in #27.
2. Verify actual firewall/port exposure, including IPv6 and Docker-published ports; do not equate absence of a public proxy route with LAN-only enforcement.
3. Test direct and proxied login, scheme detection and Secure cookie behavior without locking out the documented setup path.

---

#### 36. Open event streams outlive session revocation

**Files:** `dashboard/server.js:681–710`; `dashboard/lib/auth.js:logout()/changePassword()`  
**Pattern:** Authentication checked only at stream creation

An existing authenticated SSE connection can continue receiving summaries/activity after logout, password change or session expiry.

**Impact:** An existing authenticated SSE connection can continue receiving summaries/activity after logout, password change or session expiry.

**Fix:**

1. Define the required revocation latency for event streams. Associate connections with sessions and close on revocation, or periodically revalidate with a documented short bound.
2. Coordinate with #31 and close/unsubscribe timers and listeners without leaking resources.
3. Test active streams during logout, expiry and password change; ensure revoked sessions receive no further events after the promised bound.

---

#### 37. Backup success does not establish durable, recoverable application state

**Files:** `dashboard/lib/backup.js:create()/encryptFile()`; `dashboard/lib/updates.js:backupModule()`  
**Pattern:** Archive completion and live-database consistency need stronger validation

Tar process completion and valid GCM authentication do not prove successful output-stream completion or consistent live databases. This is a reliability observation, not a demonstrated confidentiality exploit.

**Impact:** Tar process completion and valid GCM authentication do not prove successful output-stream completion or consistent live databases. This is a reliability observation, not a demonstrated confidentiality exploit.

**Fix:**

1. Wait for successful tar output-stream completion and handle write errors before encryption/publication. Clean up incomplete files on failure.
2. Define app-specific consistency requirements for live database backups and document what each backup kind guarantees.
3. Test output/disk failures and run restore drills against disposable application data. Do not report encryption verification alone as recovery verification.

---

## Verification and limitations

The independent review ran `scripts/security-review/checks.cjs` with Node v22.23.2: **all eight reported reproduction checks completed**. The existing YAML suite reported **10 passing**. These are prior review results, not evidence that remediation has been implemented. The reproduction harness intentionally asserts current defects; replace/invert its expectations as corresponding fixes land.

Tests used harmless temporary fixtures and mocked services, with no real credentials or Docker changes. The state-file collision probe is schedule-sensitive; the stale-auth transaction test uses deterministic interleaving. Source-inspected and standards-backed conclusions are labelled above. No live-container startup/UID audit, browser penetration test, image/OS CVE scan, restore drill or signing-infrastructure validation was completed. A source review cannot establish that no issue remains.

## References

- [Independent review and original-proposal assessment](SECURITY-REVIEW.md).
- [Remediation guide](SECURITY-FIXES.md) — matching finding numbers and implementation prompts.
- [RFC 6265 §8.5: cookies lack port isolation](https://datatracker.ietf.org/doc/html/rfc6265#section-8.5).
- [MDN: SVG image restrictions versus document navigation](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image).
- [MDN: SameSite cookie behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie) and [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).
- [Node: unhandled exceptions/rejections](https://nodejs.org/api/process.html#event-uncaughtexception).
- [LinuxServer: PUID/PGID](https://docs.linuxserver.io/general/understanding-puid-and-pgid/) and [non-root container requirements](https://docs.linuxserver.io/misc/non-root/).
- [Git: tag signature verification](https://git-scm.com/docs/git-verify-tag).
