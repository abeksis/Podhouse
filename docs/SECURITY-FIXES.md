# Podhouse Security Fixes — Remediation Guide

Revised from [SECURITY-AUDIT.md](SECURITY-AUDIT.md) and the independent review on **2026-09-17**. Each entry includes a brief description, the corrected proposed fix, and a Claude prompt for implementation. **Documentation only: these fixes have not been applied.**

There are **37 entries**, including corrections and observations rather than 37 mandatory patches. Entries 1–25 retain this guide's original numbers; 26–34 add the independent-review findings, and 35–37 add deployment, revocation and backup observations. Both documents now use identical numbering (Worker = 4, headers = 5, backup GET = 6). Read the severity and prerequisites before prioritizing work.

The prompts below replace the earlier snippets. Do not apply the old blanket user changes, optional/untrusted checksums, fabricated helper calls, property-name shapeOf rewrite or raw Docker Labels filter. Preserve actual interfaces, file permissions and diagnostics, and validate against the source rather than approximate historical line numbers.

---

## 1. Container runtime identity and Docker socket authority

**Severity:** LOW / OBSERVATION  
**Files:** `dashboard/Dockerfile`; `modules/*/docker-compose.yml`; `docs/DOCKER-SOCKET.md`

**Brief description:** **Status: original UID count withdrawn; architectural observation retained.** There are 64 module Compose files. Images can declare USER themselves, and root entrypoints can drop privileges through PUID/PGID or image-specific settings. The dashboard intentionally runs as root with Docker socket access. Other apps do not inherit that mount. Runtime identities need image-specific inspection and tests before changing user settings.

**Proposed fix:**

1. Inventory each service image, inherited USER, entrypoint privilege drop, PUID/PGID support, socket mounts, devices and required capabilities.
2. Choose non-root execution per image and test startup, config writes, upgrades and devices. Do not blanket-add user: or exempt arbitrary privileged services.
3. For the Alpine dashboard image, design file ownership and runtime socket-group handling before changing UID. A fixed build-time GID is not portable. Retaining the raw socket retains host-root-equivalent authority.
4. Record unknown runtime identities explicitly; verify them on disposable running containers before claiming a count.

**Claude prompt:**

```text
In the Podhouse repository, address finding #1: Container runtime identity and Docker socket authority.

Read the relevant code in dashboard/Dockerfile; modules/*/docker-compose.yml; docs/DOCKER-SOCKET.md.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Inventory each service image, inherited USER, entrypoint privilege drop, PUID/PGID support, socket mounts, devices and required capabilities.
2. Choose non-root execution per image and test startup, config writes, upgrades and devices. Do not blanket-add user: or exempt arbitrary privileged services.
3. For the Alpine dashboard image, design file ownership and runtime socket-group handling before changing UID. A fixed build-time GID is not portable. Retaining the raw socket retains host-root-equivalent authority.
4. Record unknown runtime identities explicitly; verify them on disposable running containers before claiming a count.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 2. Self-update does not authenticate releases with a pinned signer

**Severity:** HIGH  
**Files:** `scripts/self-update.sh:295`; `docs/RELEASING.md`

**Brief description:** The updater fetches a release tag and checks it out without verifying a signature against a pinned maintainer identity. The verification comment is a TODO. The missing control concerns compromised release infrastructure: ordinary DNS poisoning alone does not bypass HTTPS certificate verification. A completed fix requires real trust material and fail-closed verification, including when tooling is absent.

**Proposed fix:**

1. Provision a real maintainer signing key/fingerprint through a trusted distribution path and define key rotation and revocation. Never ship placeholder keys as a completed fix.
2. Verify the exact fetched tag object with an isolated trusted keyring or explicit signer allowlist, then check out the verified immutable commit.
3. Fail closed on missing verification tooling, missing/invalid signatures and unauthorized signers. Do not silently skip verification or introduce a default bypass.
4. Test accepted signer, wrong signer, unsigned tag, altered tag, unavailable tooling and offline verification; document the initial trust bootstrap.

**Claude prompt:**

```text
In the Podhouse repository, address finding #2: Self-update does not authenticate releases with a pinned signer.

Read the relevant code in scripts/self-update.sh:295; docs/RELEASING.md.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Provision a real maintainer signing key/fingerprint through a trusted distribution path and define key rotation and revocation. Never ship placeholder keys as a completed fix.
2. Verify the exact fetched tag object with an isolated trusted keyring or explicit signer allowlist, then check out the verified immutable commit.
3. Fail closed on missing verification tooling, missing/invalid signatures and unauthorized signers. Do not silently skip verification or introduce a default bypass.
4. Test accepted signer, wrong signer, unsigned tag, altered tag, unavailable tooling and offline verification; document the initial trust bootstrap.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 3. Bootstrap tarball extraction lacks trusted integrity verification

**Severity:** HIGH  
**Files:** `scripts/bootstrap.sh:191–224`

**Brief description:** The custom HB_TARBALL path downloads a tarball, checks that tar can list it, then extracts it into the installation root. Listing an archive does not authenticate its contents. Verification must happen in bootstrap before extraction and execution; adding a variable to the downloaded install.sh cannot establish trust in that installer.

**Proposed fix:**

1. Use the actual HB_TARBALL branch in bootstrap.sh; require a trusted expected SHA-256 or a signed release manifest before extraction.
2. Download fully to a private temporary directory, validate the expected digest syntax and verify bytes before any extraction or execution.
3. Preserve the current archive layout/strip-components behavior; reject unsafe archive paths/links and stage extraction before publishing the install tree.
4. Fail closed on missing or mismatched verification material. A same-source unsigned checksum detects corruption but does not authenticate a compromised source.
5. Test missing hash, mismatch, truncated download, unsafe archive members and successful extraction. A variable first read in downloaded install.sh is too late.

**Claude prompt:**

```text
In the Podhouse repository, address finding #3: Bootstrap tarball extraction lacks trusted integrity verification.

Read the relevant code in scripts/bootstrap.sh:191–224.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Use the actual HB_TARBALL branch in bootstrap.sh; require a trusted expected SHA-256 or a signed release manifest before extraction.
2. Download fully to a private temporary directory, validate the expected digest syntax and verify bytes before any extraction or execution.
3. Preserve the current archive layout/strip-components behavior; reject unsafe archive paths/links and stage extraction before publishing the install tree.
4. Fail closed on missing or mismatched verification material. A same-source unsigned checksum detects corruption but does not authenticate a compromised source.
5. Test missing hash, mismatch, truncated download, unsafe archive members and successful extraction. A variable first read in downloaded install.sh is too late.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 4. Worker install entry point relies on HTTPS-origin trust

**Severity:** HIGH  
**Files:** `infra/get-worker/src/index.js:36–90`; `scripts/bootstrap.sh`

**Brief description:** The Worker proxies installer content from GitHub main, and the documented pipe executes the response as root. Trust therefore rests on the HTTPS serving origins and their administration. A checksum computed from the same upstream content, a cache header or an ETag does not establish independent authenticity. An executing script cannot authenticate its own initial execution retroactively.

**Proposed fix:**

1. Define and document the trusted distribution root for the first installer/verifier and signing key.
2. Offer a download-then-verify-then-execute flow using a separately trusted key or expected digest. Verification must finish before sudo bash executes any downloaded code.
3. Serve release-bound artifacts and detached signatures/manifests; test tampered script, wrong signer and missing verification data.
4. Do not claim an upstream-computed SHA-256 sidecar, ETag, cache header or script self-check protects against a compromised serving origin. Document remaining HTTPS-origin trust if the one-line pipe is retained.

**Claude prompt:**

```text
In the Podhouse repository, address finding #4: Worker install entry point relies on HTTPS-origin trust.

Read the relevant code in infra/get-worker/src/index.js:36–90; scripts/bootstrap.sh.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Define and document the trusted distribution root for the first installer/verifier and signing key.
2. Offer a download-then-verify-then-execute flow using a separately trusted key or expected digest. Verification must finish before sudo bash executes any downloaded code.
3. Serve release-bound artifacts and detached signatures/manifests; test tampered script, wrong signer and missing verification data.
4. Do not claim an upstream-computed SHA-256 sidecar, ETag, cache header or script self-check protects against a compromised serving origin. Document remaining HTTPS-origin trust if the one-line pipe is retained.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 5. Security HTTP response headers are missing

**Severity:** MEDIUM  
**Files:** `dashboard/server.js:124,166,177,681`; `dashboard/public/js/app.js:217`

**Brief description:** The response helpers do not set a consistent security-header policy. The index is served through serveIndex(), separately from most static-file handling. The frontend has inline onerror handlers and inline styles, so an untested strict CSP can break functionality. Downloaded content needs additional isolation under #28.

**Proposed fix:**

1. Set default response headers centrally before routing, covering serveIndex, JSON, static assets, streams, authentication and errors. Preserve existing cache controls.
2. Add nosniff, a deliberate referrer policy and frame restrictions. Design a CSP around actual script, style, image and connection use.
3. Refactor inline onerror handlers and relevant inline styles rather than broadly enabling script unsafe-inline. Test the full UI before enforcing CSP.
4. Give downloaded content its own restrictive policy as required by #28. Only enable HSTS for a verified HTTPS deployment; trust forwarded scheme headers only from configured proxies.
5. Check header coverage and exercise icon fallbacks, dialogs, inline styling replacements, downloads and streaming operations.

**Claude prompt:**

```text
In the Podhouse repository, address finding #5: Security HTTP response headers are missing.

Read the relevant code in dashboard/server.js:124,166,177,681; dashboard/public/js/app.js:217.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Set default response headers centrally before routing, covering serveIndex, JSON, static assets, streams, authentication and errors. Preserve existing cache controls.
2. Add nosniff, a deliberate referrer policy and frame restrictions. Design a CSP around actual script, style, image and connection use.
3. Refactor inline onerror handlers and relevant inline styles rather than broadly enabling script unsafe-inline. Test the full UI before enforcing CSP.
4. Give downloaded content its own restrictive policy as required by #28. Only enable HSTS for a verified HTTPS deployment; trust forwarded scheme headers only from configured proxies.
5. Check header coverage and exercise icon fallbacks, dialogs, inline styling replacements, downloads and streaming operations.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 6. Authenticated backup GET is not a demonstrated CSRF exfiltration

**Severity:** LOW / OBSERVATION  
**Files:** `dashboard/server.js:1111`; `dashboard/public/js/app.js:1454`

**Brief description:** **Status: original CSRF-exfiltration claim withdrawn.** Triggering a download does not send its response bytes to an attacker. SameSite=Lax excludes cross-site image requests from carrying the cookie, and same-origin policy governs response reading even where requests are same-site. Authenticated read-only GET downloads are valid; sensitive-response caching remains worth tightening.

**Proposed fix:**

1. Keep the authenticated read-only download contract unless a separate product requirement calls for POST.
2. Add Cache-Control: no-store to sensitive archive responses and preserve strict filename validation.
3. Test unauthenticated denial, valid authenticated streaming and malformed names. If choosing POST, add the #8 CSRF defense, check response status and account for large-archive Blob memory cost.
4. Do not describe GET-to-POST conversion as a demonstrated exfiltration fix.

**Claude prompt:**

```text
In the Podhouse repository, address finding #6: Authenticated backup GET is not a demonstrated CSRF exfiltration.

Read the relevant code in dashboard/server.js:1111; dashboard/public/js/app.js:1454.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Keep the authenticated read-only download contract unless a separate product requirement calls for POST.
2. Add Cache-Control: no-store to sensitive archive responses and preserve strict filename validation.
3. Test unauthenticated denial, valid authenticated streaming and malformed names. If choosing POST, add the #8 CSRF defense, check response status and account for large-archive Blob memory cost.
4. Do not describe GET-to-POST conversion as a demonstrated exfiltration fix.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 7. CLI meta() evaluates fixed expressions

**Severity:** LOW / OBSERVATION  
**Files:** `homebox:57–75 and meta() callers`

**Brief description:** **Status: defense-in-depth refactor, not a confirmed injection.** meta() invokes node with fixed expression strings from its callers. Some expressions use fallback values, boolean formatting or Object.keys(), so replacing eval with a dot-path accessor alone changes behavior. No current user-controlled expression was established.

**Proposed fix:**

1. Inventory every meta() expression, including fallbacks, theme access, boolean formatting and Object.keys(m.env_vars || {}).
2. Replace eval with a fixed allowlist of named operations and update all callers together. Preserve array/newline and missing-field output.
3. Use real arguments or explicit serialized input; do not refer to an undefined tmpfile. meta() currently invokes node, not node_root.
4. Test list, info and module-scoped secrets output, plus malformed metadata. Coordinate error handling with #23.

**Claude prompt:**

```text
In the Podhouse repository, address finding #7: CLI meta() evaluates fixed expressions.

Read the relevant code in homebox:57–75 and meta() callers.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Inventory every meta() expression, including fallbacks, theme access, boolean formatting and Object.keys(m.env_vars || {}).
2. Replace eval with a fixed allowlist of named operations and update all callers together. Preserve array/newline and missing-field output.
3. Use real arguments or explicit serialized input; do not refer to an undefined tmpfile. meta() currently invokes node, not node_root.
4. Test list, info and module-scoped secrets output, plus malformed metadata. Coordinate error handling with #23.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 8. Unsafe requests lack explicit Origin/CSRF validation

**Severity:** HIGH  
**Files:** `dashboard/server.js request/auth/POST handlers`; `dashboard/lib/auth.js`; `dashboard/public/js/app.js`

**Brief description:** Unsafe endpoints rely primarily on SameSite=Lax and do not explicitly validate Origin or a CSRF token. Same-site services on another origin can still send authenticated requests, including text/plain requests accepted by readBody() as JSON. Different IP addresses merely sharing a LAN subnet are not automatically the same site. Session-bound protection must cover streamed mutations and the authentication lifecycle.

**Proposed fix:**

1. Define trusted dashboard origins from configuration, not an unchecked request Host or forwarded header. Apply strict Origin validation and/or session-bound CSRF tokens to unsafe methods.
2. Integrate token creation, retrieval, rotation and expiry with actual session storage. Protect pre-session login/claim with appropriate origin checks and cover logout/password changes.
3. Update every frontend mutation, including streamed module/update/reset/storage requests, and preserve token loading after reload and password rotation.
4. Never expose the session ID as a CSRF token. Validate token type and length before timingSafeEqual; return controlled errors for malformed tokens.
5. Test same-site different-port attacks, text/plain requests, missing/foreign/null origins according to documented policy, invalid tokens and successful normal workflows.

**Claude prompt:**

```text
In the Podhouse repository, address finding #8: Unsafe requests lack explicit Origin/CSRF validation.

Read the relevant code in dashboard/server.js request/auth/POST handlers; dashboard/lib/auth.js; dashboard/public/js/app.js.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Define trusted dashboard origins from configuration, not an unchecked request Host or forwarded header. Apply strict Origin validation and/or session-bound CSRF tokens to unsafe methods.
2. Integrate token creation, retrieval, rotation and expiry with actual session storage. Protect pre-session login/claim with appropriate origin checks and cover logout/password changes.
3. Update every frontend mutation, including streamed module/update/reset/storage requests, and preserve token loading after reload and password rotation.
4. Never expose the session ID as a CSRF token. Validate token type and length before timingSafeEqual; return controlled errors for malformed tokens.
5. Test same-site different-port attacks, text/plain requests, missing/foreign/null origins according to documented policy, invalid tokens and successful normal workflows.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 9. Privileged operations need bounded work concurrency

**Severity:** MEDIUM  
**Files:** `dashboard/server.js:630 and action handlers`; `dashboard/lib/backup.js`; `dashboard/lib/platform.js`

**Brief description:** The server has per-module in-flight guards, backups have an in-flight flag and retention, and update paths have locking mechanisms. These do not establish a single bounded budget for all expensive operations or eliminate every overlapping-request race. Limits must match the actual API routes and normal administration workflows.

**Proposed fix:**

1. Inventory expensive operations and their real routes, including /api/modules/<id>/<action> and stream variants; do not rate-limit nonexistent route names.
2. Add measured global concurrency/queue bounds and atomic per-resource locks, integrating rather than duplicating existing guards.
3. If adding per-session limits, bound/prune their state, return 429 with Retry-After, and permit ordinary multi-app setup.
4. Test overlapping module installs, backup operations and platform upgrades, including error-path lock release.

**Claude prompt:**

```text
In the Podhouse repository, address finding #9: Privileged operations need bounded work concurrency.

Read the relevant code in dashboard/server.js:630 and action handlers; dashboard/lib/backup.js; dashboard/lib/platform.js.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Inventory expensive operations and their real routes, including /api/modules/<id>/<action> and stream variants; do not rate-limit nonexistent route names.
2. Add measured global concurrency/queue bounds and atomic per-resource locks, integrating rather than duplicating existing guards.
3. If adding per-session limits, bound/prune their state, return 429 with Retry-After, and permit ordinary multi-app setup.
4. Test overlapping module installs, backup operations and platform upgrades, including error-path lock release.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 10. Spoofed X-Forwarded-For bypasses login throttling

**Severity:** HIGH  
**Files:** `dashboard/lib/auth.js:267`

**Brief description:** clientIp() accepts the first X-Forwarded-For value without establishing that the TCP peer is a trusted proxy. Direct clients can change that header on every login attempt. Behind a real proxy, socket.remoteAddress identifies the proxy; original-client forwarding needs an explicit trust policy. Removing spoofable headers does not repair the independent concurrency problem in #32.

**Proposed fix:**

1. Use socket.remoteAddress by default; accept forwarded identity only from explicitly configured trusted proxy peers with a defined header-chain policy.
2. Document that socket.remoteAddress is the proxy when one is present, not the original client. Review X-Forwarded-Proto trust at the same boundary.
3. Test direct spoofed headers, trusted/untrusted proxy peers and malformed forwarded values. Implement #32 as part of the complete limiter correction.

**Claude prompt:**

```text
In the Podhouse repository, address finding #10: Spoofed X-Forwarded-For bypasses login throttling.

Read the relevant code in dashboard/lib/auth.js:267.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Use socket.remoteAddress by default; accept forwarded identity only from explicitly configured trusted proxy peers with a defined header-chain policy.
2. Document that socket.remoteAddress is the proxy when one is present, not the original client. Review X-Forwarded-Proto trust at the same boundary.
3. Test direct spoofed headers, trusted/untrusted proxy peers and malformed forwarded values. Implement #32 as part of the complete limiter correction.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 11. Backup restore passes its encryption key in argv

**Severity:** MEDIUM  
**Files:** `homebox:565–587`; `dashboard/lib/backup.js`

**Brief description:** cmd_restore() reads HB_BACKUP_KEY from .env in the shell and passes it to its Node command as an argument. The exposure is in that internal call, not a fourth shell argument supplied by the user. Protected stdin/descriptors or direct privileged key reading can preserve the existing command interface.

**Proposed fix:**

1. Keep the restore command interface; move key reading into the privileged Node restore operation using the correct install root, or pass it through protected stdin/a descriptor.
2. Remove the key from every parent and child argv, accounting for sudo behavior. Do not introduce a persistent plaintext key file.
3. Preserve key parsing and error behavior; fix private authenticated output publication under #26.
4. Test with a harmless recognizable fixture key and inspect parent/child argv; verify successful and failed restore behavior.

**Claude prompt:**

```text
In the Podhouse repository, address finding #11: Backup restore passes its encryption key in argv.

Read the relevant code in homebox:565–587; dashboard/lib/backup.js.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Keep the restore command interface; move key reading into the privileged Node restore operation using the correct install root, or pass it through protected stdin/a descriptor.
2. Remove the key from every parent and child argv, accounting for sudo behavior. Do not introduce a persistent plaintext key file.
3. Preserve key parsing and error behavior; fix private authenticated output publication under #26.
4. Test with a harmless recognizable fixture key and inspect parent/child argv; verify successful and failed restore behavior.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 12. Setup scripts receive more secrets than necessary

**Severity:** LOW / OBSERVATION  
**Files:** `dashboard/lib/compose.js:117–166`; `modules/*/setup.sh`

**Brief description:** **Status: least-exposure improvement within a trusted execution boundary.** compose.js passes parsed .env values to the fixed modules/<id>/setup.sh script. The script already has dashboard privileges and can read the file or use Docker directly. Filtering environment variables helps minimize accidental disclosure but cannot make malicious setup scripts safe.

**Proposed fix:**

1. Inventory container and setup-only environment dependencies, including paths and identity. Define an explicit supported schema for needed setup variables.
2. Filter in compose.js while preserving values containing equals signs and required inherited runtime variables. Test every affected setup path.
3. Document fixed module-local setup.sh as trusted executable code. Do not claim filtering creates an untrusted-module sandbox; that needs filesystem and Docker authority isolation.

**Claude prompt:**

```text
In the Podhouse repository, address finding #12: Setup scripts receive more secrets than necessary.

Read the relevant code in dashboard/lib/compose.js:117–166; modules/*/setup.sh.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Inventory container and setup-only environment dependencies, including paths and identity. Define an explicit supported schema for needed setup variables.
2. Filter in compose.js while preserving values containing equals signs and required inherited runtime variables. Test every affected setup path.
3. Document fixed module-local setup.sh as trusted executable code. Do not claim filtering creates an untrusted-module sandbox; that needs filesystem and Docker authority isolation.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 13. Remote icon fetching permits internal network requests

**Severity:** MEDIUM  
**Files:** `dashboard/lib/icons.js:49–109`

**Brief description:** The fetcher accepts HTTP(S), follows a limited redirect chain, checks MIME and byte size, and sets an inactivity timeout. It does not restrict destination addresses or impose a total transfer deadline. MIME checks constrain readable results but do not prevent outbound requests. A lookup followed by an independent connection leaves a DNS-rebinding gap; every redirect needs the same connection-time policy.

**Proposed fix:**

1. Specify whether private LAN icon sources are supported; enforce an explicit destination policy with narrowly scoped exceptions if needed.
2. Validate complete IPv4/IPv6/mapped-address ranges and resolve/pin the approved address at connection time while preserving correct hostname/TLS verification.
3. Revalidate every redirect and prevent DNS rebinding between validation and connection. Add an overall deadline as well as inactivity/size limits.
4. Test alternate loopback addresses, ::1, link-local and mapped addresses, public-to-private redirects, rebinding and trickling responses. Apply #28 to downloaded bytes separately.

**Claude prompt:**

```text
In the Podhouse repository, address finding #13: Remote icon fetching permits internal network requests.

Read the relevant code in dashboard/lib/icons.js:49–109.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Specify whether private LAN icon sources are supported; enforce an explicit destination policy with narrowly scoped exceptions if needed.
2. Validate complete IPv4/IPv6/mapped-address ranges and resolve/pin the approved address at connection time while preserving correct hostname/TLS verification.
3. Revalidate every redirect and prevent DNS rebinding between validation and connection. Add an overall deadline as well as inactivity/size limits.
4. Test alternate loopback addresses, ::1, link-local and mapped addresses, public-to-private redirects, rebinding and trickling responses. Apply #28 to downloaded bytes separately.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 14. Expired sessions are already pruned when sessions are created

**Severity:** LOW / OBSERVATION  
**Files:** `dashboard/lib/auth.js:119–133,169`

**Brief description:** **Status: original accumulation claim corrected.** pruneSessions(sessions) exists in auth.js and runs during createSession(). Expired sessions are rejected on authentication, and failed login attempts do not create sessions. Optional idle cleanup and active-session limits should use the serialized auth transaction from #31.

**Proposed fix:**

1. Preserve expiry enforcement and the existing pruneSessions(sessions) helper in auth.js.
2. If adding cleanup or active-session bounds, persist mutations through the serialized auth transaction from #31. Do not call an invented state-store helper or pass no sessions argument.
3. Test expiry, pruning on login, retained current sessions and interaction with logout/password changes.

**Claude prompt:**

```text
In the Podhouse repository, address finding #14: Expired sessions are already pruned when sessions are created.

Read the relevant code in dashboard/lib/auth.js:119–133,169.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Preserve expiry enforcement and the existing pruneSessions(sessions) helper in auth.js.
2. If adding cleanup or active-session bounds, persist mutations through the serialized auth transaction from #31. Do not call an invented state-store helper or pass no sessions argument.
3. Test expiry, pruning on login, retained current sessions and interaction with logout/password changes.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 15. Backup download filename validation prevents header injection

**Severity:** LOW / OBSERVATION  
**Files:** `dashboard/lib/backup.js:NAME_RE and resolveName()`; `dashboard/server.js:1111–1121`

**Brief description:** **Status: no current header injection found.** resolveName() accepts only the fixed homebox-(config|full)-timestamp.tar.gz.enc pattern. Quotes, CR/LF, backslashes and traversal characters cannot reach Content-Disposition through this route. Additional encoding is optional defense in depth and must preserve the strict path allowlist.

**Proposed fix:**

1. Retain the strict backup filename allowlist and validate before setting Content-Disposition.
2. Optionally add defensive filename encoding without broadening allowed filesystem paths.
3. Test quotes, CR/LF, encoded separators and valid archive names; do not weaken validation in the name of escaping.

**Claude prompt:**

```text
In the Podhouse repository, address finding #15: Backup download filename validation prevents header injection.

Read the relevant code in dashboard/lib/backup.js:NAME_RE and resolveName(); dashboard/server.js:1111–1121.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Retain the strict backup filename allowlist and validate before setting Content-Disposition.
2. Optionally add defensive filename encoding without broadening allowed filesystem paths.
3. Test quotes, CR/LF, encoded separators and valid archive names; do not weaken validation in the name of escaping.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 16. sed-based environment replacement is fragile

**Severity:** LOW / OBSERVATION  
**Files:** `install.sh:env_force()`; `modules/metrics/setup.sh`

**Brief description:** env_force() interpolates replacement values into a sed expression, and metrics setup has a related pattern. Current version and derived-key inputs are controlled, but the replacement helper is unsafe for general literal values. A replacement must preserve permissions, reject newlines and handle a file whose only line is removed; grep -v returns 1 in that valid empty-output case.

**Proposed fix:**

1. Replace interpolation into sed programs with literal-value serialization; validate keys and reject CR/LF. Preserve comments, unknown values, mode and owner.
2. Use private atomic replacement and handle a single-key file/empty filtered output correctly. grep -v exit 1 is not necessarily an error; awk -v also interprets escapes.
3. Test ampersands, delimiters, backslashes, quotes, empty values, only-line replacement and rejected newlines.

**Claude prompt:**

```text
In the Podhouse repository, address finding #16: sed-based environment replacement is fragile.

Read the relevant code in install.sh:env_force(); modules/metrics/setup.sh.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Replace interpolation into sed programs with literal-value serialization; validate keys and reject CR/LF. Preserve comments, unknown values, mode and owner.
2. Use private atomic replacement and handle a single-key file/empty filtered output correctly. grep -v exit 1 is not necessarily an error; awk -v also interprets escapes.
3. Test ampersands, delimiters, backslashes, quotes, empty values, only-line replacement and rejected newlines.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 17. Install ownership fallback needs explicit legacy recovery

**Severity:** LOW / OBSERVATION  
**Files:** `install.sh:42–47,230`; `scripts/self-update.sh:chown_back()`; `dashboard/lib/storage.js:onHostDetached()`

**Brief description:** **Status: normal update ownership regression already addressed.** install.sh first obtains an existing non-root tree owner before falling back to explicit/sudo/current-user identity. A legacy tree already owned by root needs a deliberate recovery policy. Selecting the first UID >=1000 is not proof of ownership and could grant the wrong account access to secrets and executable scripts.

**Proposed fix:**

1. Preserve the existing non-root-owner path and honor a validated explicit HB_USER.
2. For ambiguous root-owned legacy installations, use a verified recorded owner or require an explicit recovery owner. Do not select the first UID >=1000.
3. Test ordinary sudo, nsenter with no SUDO_USER, explicit owner and legacy-root cases; preserve module config ownership exemptions.

**Claude prompt:**

```text
In the Podhouse repository, address finding #17: Install ownership fallback needs explicit legacy recovery.

Read the relevant code in install.sh:42–47,230; scripts/self-update.sh:chown_back(); dashboard/lib/storage.js:onHostDetached().
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Preserve the existing non-root-owner path and honor a validated explicit HB_USER.
2. For ambiguous root-owned legacy installations, use a verified recorded owner or require an explicit recovery owner. Do not select the first UID >=1000.
3. Test ordinary sudo, nsenter with no SUDO_USER, explicit owner and legacy-root cases; preserve module config ownership exemptions.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 18. Module setup passwords are exposed in process arguments

**Severity:** MEDIUM  
**Files:** `modules/vpn/setup.sh`; `modules/authelia/setup.sh`

**Brief description:** VPN and Authelia setup pass passwords to container hashing commands as arguments. Moving a password into docker -e NAME=value still exposes it in host argv, and expanding a protected file into --password exposes the child argv. Input support must be checked for the pinned tool; a guessed stdin interface is not a working fix.

**Proposed fix:**

1. Inspect each pinned image/tool for a supported stdin or protected-file password API; use a verified interface, not a guessed wgpw stdin mode.
2. Keep secrets out of host docker argv and container child argv. docker -e NAME=value and sh -c expansion into --password do not solve disclosure.
3. If tools lack safe input, choose a compatible controlled hashing implementation and test generated hashes against the actual application.
4. Inspect host/child argument lists using fixture passwords and test failure cleanup. Matrix environment passing is not evidence of a safe password-input API.

**Claude prompt:**

```text
In the Podhouse repository, address finding #18: Module setup passwords are exposed in process arguments.

Read the relevant code in modules/vpn/setup.sh; modules/authelia/setup.sh.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Inspect each pinned image/tool for a supported stdin or protected-file password API; use a verified interface, not a guessed wgpw stdin mode.
2. Keep secrets out of host docker argv and container child argv. docker -e NAME=value and sh -c expansion into --password do not solve disclosure.
3. If tools lack safe input, choose a compatible controlled hashing implementation and test generated hashes against the actual application.
4. Inspect host/child argument lists using fixture passwords and test failure cleanup. Matrix environment passing is not evidence of a safe password-input API.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 19. shapeOf() comment matches the implementation

**Severity:** LOW / OBSERVATION  
**Files:** `dashboard/lib/versions.js:27–28`

**Brief description:** **Status: false positive withdrawn; no fix required.** shapeOf() replaces digit runs with actual NUL characters, matching its comment. It returns a string, not an object mapping property names to true. The isolated fixture verified its exact output.

**Proposed fix:**

1. Make no implementation or comment change for the original claim.
2. Retain the exact-output fixture confirming shapeOf("v1.6.0-ls362") has NUL placeholders; preserve version comparison behavior.

**Claude prompt:**

```text
In the Podhouse repository, address finding #19: shapeOf() comment matches the implementation.

Read the relevant code in dashboard/lib/versions.js:27–28.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Make no implementation or comment change for the original claim.
2. Retain the exact-output fixture confirming shapeOf("v1.6.0-ls362") has NUL placeholders; preserve version comparison behavior.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 20. Privileged module capabilities should be visible

**Severity:** LOW / OBSERVATION  
**Files:** `modules/homeassistant/docker-compose.yml`; `modules/coolercontrol/docker-compose.yml`; `other host-access modules`; `docs/MODULE-SCHEMA.md`

**Brief description:** **Status: accepted capability requiring clear documentation.** Selected modules deliberately request privileged mode, host networking, devices or socket access. These are different capabilities and should be described accurately. Any metadata belongs inside the existing x-homebox mapping and needs validation/UI integration to influence behavior.

**Proposed fix:**

1. Describe privileges separately in the existing nested x-homebox metadata; do not create a literal top-level x-homebox.privileged key.
2. Connect metadata to validation and installation UI explanations, distinguishing host network, privileged mode, device and Docker socket access.
3. Test schema parsing and UI display, and verify declarations match actual Compose configuration.

**Claude prompt:**

```text
In the Podhouse repository, address finding #20: Privileged module capabilities should be visible.

Read the relevant code in modules/homeassistant/docker-compose.yml; modules/coolercontrol/docker-compose.yml; other host-access modules; docs/MODULE-SCHEMA.md.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Describe privileges separately in the existing nested x-homebox metadata; do not create a literal top-level x-homebox.privileged key.
2. Connect metadata to validation and installation UI explanations, distinguishing host network, privileged mode, device and Docker socket access.
3. Test schema parsing and UI display, and verify declarations match actual Compose configuration.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 21. Module-scoped CLI secret display is intentional

**Severity:** LOW / OBSERVATION  
**Files:** `homebox:519–528`

**Brief description:** **Status: intentional administrative functionality.** cmd_secrets() requires a module, reads its declared variable names and prints those values. It does not dump the complete .env by default. Masking and explicit raw output are optional interface changes; preserving module scope is essential.

**Proposed fix:**

1. Preserve module scoping. If masking is desired, design an explicit raw-output option and compatibility behavior.
2. Mask the entire secret by default rather than leaking a fixed prefix; avoid secret values in audit logs.
3. Test that unrelated module secrets never appear and that missing values and explicit raw output behave as documented.

**Claude prompt:**

```text
In the Podhouse repository, address finding #21: Module-scoped CLI secret display is intentional.

Read the relevant code in homebox:519–528.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Preserve module scoping. If masking is desired, design an explicit raw-output option and compatibility behavior.
2. Mask the entire secret by default rather than leaking a fixed prefix; avoid secret values in audit logs.
3. Test that unrelated module secrets never appear and that missing values and explicit raw output behave as documented.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 22. Inline Node scripts are a maintenance concern

**Severity:** LOW / OBSERVATION  
**Files:** `homebox`; `modules/metrics/setup.sh`

**Brief description:** **Status: maintenance observation.** Inline node -e scripts are not intrinsically unsafe when source is fixed and data is passed through argv. Extraction can improve testing, but must preserve root selection, environment, privilege and output behavior. It should support concrete fixes rather than displace them.

**Proposed fix:**

1. Extract only where it improves testing or supports concrete fixes, preserving argv, root/environment setup, privilege and output contracts.
2. Exercise the affected CLI commands and existing YAML tests. Prioritize verified security findings over broad extraction.

**Claude prompt:**

```text
In the Podhouse repository, address finding #22: Inline Node scripts are a maintenance concern.

Read the relevant code in homebox; modules/metrics/setup.sh.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Extract only where it improves testing or supports concrete fixes, preserving argv, root/environment setup, privilege and output contracts.
2. Exercise the affected CLI commands and existing YAML tests. Prioritize verified security findings over broad extraction.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 23. meta() suppresses parsing and execution errors

**Severity:** LOW / OBSERVATION  
**Files:** `homebox:57–75`

**Brief description:** **Status: reliability observation.** meta() discards stderr and forces success, potentially hiding broken metadata or failed Node execution. Changing this under set -e requires checking all callers and distinguishing optional missing fields from malformed input. Coordinate with the explicit-operation refactor in #7.

**Proposed fix:**

1. Coordinate with #7. Distinguish an absent optional field from a malformed file or failed Node process.
2. Preserve useful caller diagnostics and safe behavior under set -e; avoid snippets using nonexistent meta.js/tmpfile variables.
3. Test malformed YAML, missing optional fields and CLI callers with expected empty output.

**Claude prompt:**

```text
In the Podhouse repository, address finding #23: meta() suppresses parsing and execution errors.

Read the relevant code in homebox:57–75.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Coordinate with #7. Distinguish an absent optional field from a malformed file or failed Node process.
2. Preserve useful caller diagnostics and safe behavior under set -e; avoid snippets using nonexistent meta.js/tmpfile variables.
3. Test malformed YAML, missing optional fields and CLI callers with expected empty output.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 24. All-container listing is an intentional host-admin feature

**Severity:** LOW / OBSERVATION  
**Files:** `dashboard/server.js:/api/containers and container/log routes`; `dashboard/lib/docker.js:listContainers()`

**Brief description:** **Status: intentional host-admin scope.** The authenticated dashboard exposes unmanaged workloads as well as its own. docker.listContainers() returns normalized objects with a project field; raw Docker Labels are not retained. A narrower policy would need consistent enforcement on logs/actions as well as listing.

**Proposed fix:**

1. Keep current behavior unless a managed-only policy is explicitly selected.
2. If narrowing scope, use normalized c.project, not nonexistent c.Labels, and apply the same policy to listing, logs and actions.
3. Test managed/unmanaged containers and helper logs, with clear UI handling for intentionally hidden workloads.

**Claude prompt:**

```text
In the Podhouse repository, address finding #24: All-container listing is an intentional host-admin feature.

Read the relevant code in dashboard/server.js:/api/containers and container/log routes; dashboard/lib/docker.js:listContainers().
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Keep current behavior unless a managed-only policy is explicitly selected.
2. If narrowing scope, use normalized c.project, not nonexistent c.Labels, and apply the same policy to listing, logs and actions.
3. Test managed/unmanaged containers and helper logs, with clear UI handling for intentionally hidden workloads.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 25. Unexpected errors can reveal unnecessary internal detail

**Severity:** LOW / OBSERVATION  
**Files:** `dashboard/server.js catch blocks`; `dashboard/lib/docker.js`

**Brief description:** Unexpected errors can include internal filesystem paths and daemon response details. Expected validation and operational errors remain useful to the authenticated administrator. Redaction must cover server logs as well as client responses; copying arbitrary Docker output into console.error can simply move a secret disclosure.

**Proposed fix:**

1. Separate validation/expected operational errors from unexpected failures; return safe messages and correlation IDs for the latter.
2. Keep diagnostic detail internally but redact passwords, tokens and sensitive command output before logging.
3. Test filesystem and Docker failures and verify neither responses nor logs contain fixture secrets. Resolve unhandled failures under #29 first.

**Claude prompt:**

```text
In the Podhouse repository, address finding #25: Unexpected errors can reveal unnecessary internal detail.

Read the relevant code in dashboard/server.js catch blocks; dashboard/lib/docker.js.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Separate validation/expected operational errors from unexpected failures; return safe messages and correlation IDs for the latter.
2. Keep diagnostic detail internally but redact passwords, tokens and sensitive command output before logging.
3. Test filesystem and Docker failures and verify neither responses nor logs contain fixture secrets. Resolve unhandled failures under #29 first.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 26. Plaintext backup and credential files expose secrets

**Severity:** HIGH  
**Files:** `scripts/self-update.sh:80,271`; `dashboard/lib/backup.js:113,159,245`; `dashboard/lib/updates.js:433–457`; `homebox:578`; `modules/core/setup.sh`; `modules/portainer/setup.sh`; `scripts/mount-remote.sh`

**Brief description:** A local account able to traverse the install tree can read passwords, backup keys and live sessions in plaintext rollback archives. Staging/restore and write-then-chmod files add exposure windows.

**Proposed fix:**

1. Create backup/staging/restore directories privately at 0700 and files exclusively at 0600 before writing secrets. Apply restrictive shell umasks before tar or credential-file writes.
2. Use unique staging paths, remove failed outputs and publish decrypted data only after successful GCM authentication. Handle abandoned staging files after crashes safely.
3. Secure existing artifacts and directories; decide explicitly whether rollback backups need encryption. Do not claim all backups are encrypted while platform rollback tars remain plaintext.
4. Cover platform backups, Backup Center, per-module backups, restore and setup/SMB credential files. Assess credential/session rotation if unauthorized access to old readable copies was possible.
5. Test under umask 022, verify an unprivileged account cannot read files while they are being written, and test corrupt authentication tags and disk failures.

**Claude prompt:**

```text
In the Podhouse repository, address finding #26: Plaintext backup and credential files expose secrets.

Read the relevant code in scripts/self-update.sh:80,271; dashboard/lib/backup.js:113,159,245; dashboard/lib/updates.js:433–457; homebox:578; modules/core/setup.sh; modules/portainer/setup.sh; scripts/mount-remote.sh.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Create backup/staging/restore directories privately at 0700 and files exclusively at 0600 before writing secrets. Apply restrictive shell umasks before tar or credential-file writes.
2. Use unique staging paths, remove failed outputs and publish decrypted data only after successful GCM authentication. Handle abandoned staging files after crashes safely.
3. Secure existing artifacts and directories; decide explicitly whether rollback backups need encryption. Do not claim all backups are encrypted while platform rollback tars remain plaintext.
4. Cover platform backups, Backup Center, per-module backups, restore and setup/SMB credential files. Assess credential/session rotation if unauthorized access to old readable copies was possible.
5. Test under umask 022, verify an unprivileged account cannot read files while they are being written, and test corrupt authentication tags and disk failures.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 27. Dashboard cookies are shared across ports on the same host

**Severity:** HIGH  
**Files:** `dashboard/lib/auth.js:145`; `dashboard/lib/modules.js`; `modules/dashboard/docker-compose.yml`

**Brief description:** A compromised app server on another port of the same hostname can receive hb_session when the administrator visits it, then replay that cookie against the dashboard. HttpOnly does not hide it from receiving servers.

**Proposed fix:**

1. Configure a dedicated dashboard hostname with host-only cookies and HTTPS. Do not serve unrelated apps on that hostname at other ports.
2. Reject or redirect shared-IP/host aliases before allowing login/claim or setting cookies; document supported proxy/hostname configuration.
3. Expire/migrate old sessions and cookies deliberately. Cookie name changes, path changes or SameSite=Strict are not reliable port isolation.
4. Add #8 Origin/CSRF protection for same-site sibling services. Use a browser fixture to confirm a second app receives no dashboard cookie and cannot forge unsafe requests.

**Claude prompt:**

```text
In the Podhouse repository, address finding #27: Dashboard cookies are shared across ports on the same host.

Read the relevant code in dashboard/lib/auth.js:145; dashboard/lib/modules.js; modules/dashboard/docker-compose.yml.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Configure a dedicated dashboard hostname with host-only cookies and HTTPS. Do not serve unrelated apps on that hostname at other ports.
2. Reject or redirect shared-IP/host aliases before allowing login/claim or setting cookies; document supported proxy/hostname configuration.
3. Expire/migrate old sessions and cookies deliberately. Cookie name changes, path changes or SameSite=Strict are not reliable port isolation.
4. Add #8 Origin/CSRF protection for same-site sibling services. Use a browser fixture to confirm a second app receives no dashboard cookie and cannot forge unsafe requests.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 28. Downloaded SVG can execute as a dashboard-origin document

**Severity:** HIGH  
**Files:** `dashboard/lib/icons.js:36,113`; `dashboard/server.js:177`

**Brief description:** An imported attacker-controlled SVG can execute authenticated dashboard requests when opened directly or embedded as a document. Normal img rendering alone does not execute SVG scripts.

**Proposed fix:**

1. Initially reject downloaded SVG and validate accepted raster bytes, or use a maintained sanitization/rasterization implementation. Do not trust Content-Type alone.
2. Alternatively isolate user content on a credential-free origin. Add a restrictive content-specific policy, such as sandbox with default-src none and script-src none, where applicable.
3. Preserve shipped trusted icons separately and test compatibility. Global script-src self is not a substitute for downloaded-content isolation.
4. Test script-bearing SVG, event handlers, external references, mislabeled content, ordinary img rendering and direct document navigation in a browser.

**Claude prompt:**

```text
In the Podhouse repository, address finding #28: Downloaded SVG can execute as a dashboard-origin document.

Read the relevant code in dashboard/lib/icons.js:36,113; dashboard/server.js:177.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Initially reject downloaded SVG and validate accepted raster bytes, or use a maintained sanitization/rasterization implementation. Do not trust Content-Type alone.
2. Alternatively isolate user content on a credential-free origin. Add a restrictive content-specific policy, such as sandbox with default-src none and script-src none, where applicable.
3. Preserve shipped trusted icons separately and test compatibility. Global script-src self is not a substitute for downloaded-content isolation.
4. Test script-bearing SVG, event handlers, external references, mislabeled content, ordinary img rendering and direct document navigation in a browser.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 29. Malformed requests escape the server error boundary

**Severity:** HIGH  
**Files:** `dashboard/server.js:732–736,166–220`

**Brief description:** Malformed Host parsing rejects the async listener before try/catch. Default Node 22 unhandled rejection behavior can terminate the process; repeated requests can defeat restart recovery.

**Proposed fix:**

1. Move URL parsing/validation inside the request error boundary, use a fixed base where Host is unnecessary, and return 400 for invalid request targets/hosts.
2. Await or explicitly catch async response helpers. Attach stream error handlers and account for already-sent headers and disconnected clients.
3. Test malformed Host and request targets in a disposable child server; assert the server remains alive and handles a following valid request.
4. Test files disappearing between stat and streaming, and asynchronous read failures; do not merely install a global exception handler that leaves request state broken.

**Claude prompt:**

```text
In the Podhouse repository, address finding #29: Malformed requests escape the server error boundary.

Read the relevant code in dashboard/server.js:732–736,166–220.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Move URL parsing/validation inside the request error boundary, use a fixed base where Host is unnecessary, and return 400 for invalid request targets/hosts.
2. Await or explicitly catch async response helpers. Attach stream error handlers and account for already-sent headers and disconnected clients.
3. Test malformed Host and request targets in a disposable child server; assert the server remains alive and handles a following valid request.
4. Test files disappearing between stat and streaming, and asynchronous read failures; do not merely install a global exception handler that leaves request state broken.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 30. Request body rejection does not stop memory growth

**Severity:** MEDIUM  
**Files:** `dashboard/server.js:712–729`

**Brief description:** readBody continues appending data after rejecting at 16384 string units. Login/claim requests can retain more input than the documented cap.

**Proposed fix:**

1. Count bytes before retaining chunks and stop retaining data immediately on overflow; send 413 with deliberate bounded drain or connection termination.
2. Handle aborts/errors once, detach obsolete listeners and add a total upload deadline. Decode valid bounded input safely.
3. Test oversized chunked input, misleading/missing Content-Length, multibyte text, slow uploads and additional chunks after rejection. Assert bounded retained input.

**Claude prompt:**

```text
In the Podhouse repository, address finding #30: Request body rejection does not stop memory growth.

Read the relevant code in dashboard/server.js:712–729.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Count bytes before retaining chunks and stop retaining data immediately on overflow; send 413 with deliberate bounded drain or connection termination.
2. Handle aborts/errors once, detach obsolete listeners and add a total upload deadline. Decode valid bounded input safely.
3. Test oversized chunked input, misleading/missing Content-Length, multibyte text, slow uploads and additional chunks after rejection. Assert bounded retained input.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 31. Concurrent auth/state writes can undo credential revocation

**Severity:** HIGH  
**Files:** `dashboard/lib/auth.js:127,217,243`; `dashboard/lib/state-store.js:49`; `dashboard/lib/config.js`; `dashboard/lib/secrets.js`

**Brief description:** An old-password login can overwrite a completed password change with its stale password/session snapshot. Same-process state writes also share a temp filename, producing rename failures and interference.

**Proposed fix:**

1. Serialize the full read/validate/mutate/write transaction for auth, including password checks and session decisions; coordinate CLI/dashboard writers where they share files.
2. Use unique exclusive private temp files and atomic publication, with error cleanup. Unique filenames alone do not solve stale snapshots.
3. Apply compatible transaction handling to .env config/secret generation and other shared state writers. Define lock failure/crash recovery safely.
4. Add deterministic interleaving tests for login versus password change/logout/claim, and concurrent config/secret writes. Prove old credentials/sessions cannot be restored after revocation.

**Claude prompt:**

```text
In the Podhouse repository, address finding #31: Concurrent auth/state writes can undo credential revocation.

Read the relevant code in dashboard/lib/auth.js:127,217,243; dashboard/lib/state-store.js:49; dashboard/lib/config.js; dashboard/lib/secrets.js.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Serialize the full read/validate/mutate/write transaction for auth, including password checks and session decisions; coordinate CLI/dashboard writers where they share files.
2. Use unique exclusive private temp files and atomic publication, with error cleanup. Unique filenames alone do not solve stale snapshots.
3. Apply compatible transaction handling to .env config/secret generation and other shared state writers. Define lock failure/crash recovery safely.
4. Add deterministic interleaving tests for login versus password change/logout/claim, and concurrent config/secret writes. Prove old credentials/sessions cannot be restored after revocation.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 32. Concurrent login attempts bypass the failure budget

**Severity:** MEDIUM  
**Files:** `dashboard/lib/auth.js:178–235`

**Brief description:** For a new IP, concurrent attempts obtain separate counters before read() resolves. Twenty wrong-password attempts can all pass the eight-attempt gate; synchronous scrypt and unpruned limiter state also affect availability.

**Proposed fix:**

1. Reserve/count attempts synchronously before I/O or password verification and share a registered counter for each identity.
2. Bound/prune limiter state and impose a global verification-concurrency budget; use asynchronous scrypt with a bounded queue.
3. Cover claim/login and authenticated password verification with suitable budgets, avoiding trivial permanent account lockout. Integrate trusted-peer handling from #10.
4. Test a simultaneous burst from one fresh IP, sequential attempts, rotating spoofed headers, expiry, success handling and saturation recovery.

**Claude prompt:**

```text
In the Podhouse repository, address finding #32: Concurrent login attempts bypass the failure budget.

Read the relevant code in dashboard/lib/auth.js:178–235.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Reserve/count attempts synchronously before I/O or password verification and share a registered counter for each identity.
2. Bound/prune limiter state and impose a global verification-concurrency budget; use asynchronous scrypt with a bounded queue.
3. Cover claim/login and authenticated password verification with suitable budgets, avoiding trivial permanent account lockout. Integrate trusted-peer handling from #10.
4. Test a simultaneous burst from one fresh IP, sequential attempts, rotating spoofed headers, expiry, success handling and saturation recovery.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 33. Generated modules bypass declared hardening requirements

**Severity:** MEDIUM  
**Files:** `dashboard/lib/catalog.js:169`; `dashboard/lib/compose.js:169`; `homebox:623`

**Brief description:** Generated app Compose files omit no-new-privileges and cap_drop: ALL, and the dashboard install path does not enforce the CLI validator. Declaring keys alone does not guarantee their security values.

**Proposed fix:**

1. Add compatible generated-service hardening defaults and a shared policy validator used by create/install and CLI paths.
2. Validate actual normalized Compose values, including relevant overrides, not just matching key names. Define narrow documented per-service exceptions.
3. Do not blanket-add user: or accept privileged: true as an automatic escape hatch. Follow image-specific verification in #1.
4. Test generated apps, explicit disabled no-new-privileges, incomplete capability dropping, overrides and approved exceptions through real installation validation.

**Claude prompt:**

```text
In the Podhouse repository, address finding #33: Generated modules bypass declared hardening requirements.

Read the relevant code in dashboard/lib/catalog.js:169; dashboard/lib/compose.js:169; homebox:623.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Add compatible generated-service hardening defaults and a shared policy validator used by create/install and CLI paths.
2. Validate actual normalized Compose values, including relevant overrides, not just matching key names. Define narrow documented per-service exceptions.
3. Do not blanket-add user: or accept privileged: true as an automatic escape hatch. Follow image-specific verification in #1.
4. Test generated apps, explicit disabled no-new-privileges, incomplete capability dropping, overrides and approved exceptions through real installation validation.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 34. The final release freeze check fails open

**Severity:** MEDIUM  
**Files:** `scripts/self-update.sh:314–329`

**Brief description:** Failed control-ref fetch or an empty manifest falls through to checkout despite the fails-closed comment. An earlier dashboard check cannot make this later check authoritative, and explicit CLI targets also exist.

**Proposed fix:**

1. Stop on control-ref fetch failure, missing/empty manifest, malformed JSON or invalid schema before checkout/migration/install.
2. Enforce freeze: true and preserve the immutable verified release identity from #2 through execution.
3. Test unavailable control ref, missing manifest, malformed/schema-invalid manifest, frozen release and successful allowed release using disposable git fixtures.

**Claude prompt:**

```text
In the Podhouse repository, address finding #34: The final release freeze check fails open.

Read the relevant code in scripts/self-update.sh:314–329.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Stop on control-ref fetch failure, missing/empty manifest, malformed JSON or invalid schema before checkout/migration/install.
2. Enforce freeze: true and preserve the immutable verified release identity from #2 through execution.
3. Test unavailable control ref, missing manifest, malformed/schema-invalid manifest, frozen release and successful allowed release using disposable git fixtures.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 35. LAN-only access and transport protection are deployment assumptions

**Severity:** LOW / OBSERVATION  
**Files:** `dashboard/server.js:server.listen()`; `modules/dashboard/docker-compose.yml:ports`; `docs/SECURITY.md`

**Brief description:** The published port is not restricted to a LAN address by the application. Plain HTTP permits an on-path observer to obtain credentials/session cookies; exposure depends on routing and firewall configuration.

**Proposed fix:**

1. Document and implement explicit listen/publish-address and trusted-proxy settings appropriate to the supported deployment. Pair with the dedicated HTTPS hostname in #27.
2. Verify actual firewall/port exposure, including IPv6 and Docker-published ports; do not equate absence of a public proxy route with LAN-only enforcement.
3. Test direct and proxied login, scheme detection and Secure cookie behavior without locking out the documented setup path.

**Claude prompt:**

```text
In the Podhouse repository, address finding #35: LAN-only access and transport protection are deployment assumptions.

Read the relevant code in dashboard/server.js:server.listen(); modules/dashboard/docker-compose.yml:ports; docs/SECURITY.md.
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Document and implement explicit listen/publish-address and trusted-proxy settings appropriate to the supported deployment. Pair with the dedicated HTTPS hostname in #27.
2. Verify actual firewall/port exposure, including IPv6 and Docker-published ports; do not equate absence of a public proxy route with LAN-only enforcement.
3. Test direct and proxied login, scheme detection and Secure cookie behavior without locking out the documented setup path.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 36. Open event streams outlive session revocation

**Severity:** LOW / OBSERVATION  
**Files:** `dashboard/server.js:681–710`; `dashboard/lib/auth.js:logout()/changePassword()`

**Brief description:** An existing authenticated SSE connection can continue receiving summaries/activity after logout, password change or session expiry.

**Proposed fix:**

1. Define the required revocation latency for event streams. Associate connections with sessions and close on revocation, or periodically revalidate with a documented short bound.
2. Coordinate with #31 and close/unsubscribe timers and listeners without leaking resources.
3. Test active streams during logout, expiry and password change; ensure revoked sessions receive no further events after the promised bound.

**Claude prompt:**

```text
In the Podhouse repository, address finding #36: Open event streams outlive session revocation.

Read the relevant code in dashboard/server.js:681–710; dashboard/lib/auth.js:logout()/changePassword().
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Define the required revocation latency for event streams. Associate connections with sessions and close on revocation, or periodically revalidate with a documented short bound.
2. Coordinate with #31 and close/unsubscribe timers and listeners without leaking resources.
3. Test active streams during logout, expiry and password change; ensure revoked sessions receive no further events after the promised bound.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## 37. Backup success does not establish durable, recoverable application state

**Severity:** LOW / OBSERVATION  
**Files:** `dashboard/lib/backup.js:create()/encryptFile()`; `dashboard/lib/updates.js:backupModule()`

**Brief description:** Tar process completion and valid GCM authentication do not prove successful output-stream completion or consistent live databases. This is a reliability observation, not a demonstrated confidentiality exploit.

**Proposed fix:**

1. Wait for successful tar output-stream completion and handle write errors before encryption/publication. Clean up incomplete files on failure.
2. Define app-specific consistency requirements for live database backups and document what each backup kind guarantees.
3. Test output/disk failures and run restore drills against disposable application data. Do not report encryption verification alone as recovery verification.

**Claude prompt:**

```text
In the Podhouse repository, address finding #37: Backup success does not establish durable, recoverable application state.

Read the relevant code in dashboard/lib/backup.js:create()/encryptFile(); dashboard/lib/updates.js:backupModule().
Use the matching SECURITY-AUDIT.md entry for prerequisites and evidence.

1. Wait for successful tar output-stream completion and handle write errors before encryption/publication. Clean up incomplete files on failure.
2. Define app-specific consistency requirements for live database backups and document what each backup kind guarantees.
3. Test output/disk failures and run restore drills against disposable application data. Do not report encryption verification alone as recovery verification.

Keep the change scoped to this finding and its stated dependencies.
Report what changed, the checks run, and unresolved runtime or deployment requirements.
Do not describe an observation or withdrawn claim as a confirmed exploit.
```

---

## Implementation Order

| Priority | Severity | Fixes | Acceptance criteria |
|----------|----------|-------|---------------------|
| 1 | HIGH | **26** — private secret/backup files | Restrictive permissions from creation, protected old artifacts, cleanup on failed authentication/write. |
| 2 | HIGH | **27, 35** — dashboard hostname and HTTPS deployment | Other apps receive no dashboard bearer cookie; supported direct/proxy setup remains usable. |
| 3 | HIGH / MEDIUM | **29, 30, 10, 32** — request and authentication availability | Malformed requests do not kill the process; body memory is bounded; spoofed headers and concurrent attempts cannot evade budgets. |
| 4 | HIGH | **31** — serialized auth/state mutation | Concurrent login cannot restore revoked credentials; config/secret writes do not collide or lose updates. |
| 5 | HIGH / MEDIUM | **8, 28, 5** — browser-origin defenses | Same-site forged mutations are denied; downloaded content cannot execute with dashboard authority; tested CSP preserves UI behavior. |
| 6 | HIGH / MEDIUM | **2, 3, 4, 34** — release trust and freeze checks | Trusted signer/digest verified before execution; verification and release-control failures stop installation. |
| 7 | MEDIUM | **33, 9, 13, 11, 18** — hardening and bounded operations | Generated services meet actual policy; queues/fetches are bounded; passwords are absent from parent/child argv. |
| 8 | LOW / OBSERVATION | **1, 12, 16, 17, 20, 25, 36, 37** | Image-specific compatibility, least exposure, owner preservation, redacted diagnostics, stream revocation and tested restores. |
| 9 | LOW / OBSERVATION | **6, 7, 14, 15, 19, 21, 22, 23, 24** | Preserve valid behavior; optional improvements only. No patch needed for withdrawn claims such as #19. |

## Validation Notes

- `scripts/security-review/checks.cjs` is a **defect reproduction harness**, not a passing security-regression suite. It currently confirms faulty behavior; convert relevant checks into expectations of safe behavior as changes are implemented.
- The review recorded eight reproduction checks and ten passing YAML tests. These do not validate unimplemented fixes or image compatibility.
- Use temporary fixtures and disposable services for failure/interleaving tests. Browser checks, runtime identity/startup tests, restore drills and signing-key provisioning remain necessary for their respective fixes.
- Full evidence, limitations and primary protocol/tool references are in [SECURITY-AUDIT.md](SECURITY-AUDIT.md) and the historical [independent review](SECURITY-REVIEW.md).
