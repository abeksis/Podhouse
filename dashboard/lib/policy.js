'use strict';
/**
 * The one definition of "this module states what it may do".
 *
 * There were two before, and that was the bug: `homebox validate` enforced the
 * rule, while an app added from the App Store was written by a different code
 * path that never saw it — so the project's own claim about every module was
 * true of the shipped ones and false of the generated ones. The CLI, the
 * generator and the install path all call this now.
 *
 * What it checks is presence and value, not the mere existence of a key:
 *
 *   security_opt must contain no-new-privileges:true
 *   cap_drop     must contain ALL
 *
 * A service that genuinely needs the host says `privileged: true` instead, out
 * loud, and is exempt — see docs/MODULE-SCHEMA.md.
 *
 * Text, not parsed YAML, deliberately: this runs against the file as written,
 * comments and all, and must not depend on the small YAML reader agreeing with
 * Compose about anything.
 */

function servicesOf(text) {
  const lines = String(text || '').split('\n');
  const at = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (at < 0) return [];
  const starts = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i]) && lines[i].trim() !== '') break;
    if (/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(lines[i])) starts.push(i);
  }
  return starts.map((start, n) => ({
    name: lines[start].trim().replace(/:$/, ''),
    body: lines.slice(start, starts[n + 1] ?? lines.length),
  }));
}

/** Every service that does not say what it may do, with what it is missing. */
function gaps(text) {
  const out = [];
  for (const service of servicesOf(text)) {
    const has = (re) => service.body.some((l) => re.test(l));
    if (has(/^ {4}privileged:\s*true\s*$/)) continue;

    const missing = [];
    // The value matters: `security_opt: [seccomp=unconfined]` is a declaration
    // of the opposite.
    if (!has(/^ {6}- *no-new-privileges:true\s*$/)) missing.push('no-new-privileges:true');
    if (!has(/^ {4}cap_drop:/) || !has(/^ {6}- *ALL\s*$/)) missing.push('cap_drop: ALL');
    if (missing.length) out.push({ service: service.name, missing });
  }
  return out;
}

/** A one-line description of what is wrong, or null when nothing is. */
function describe(text) {
  const found = gaps(text);
  if (!found.length) return null;
  return found.map((g) => `${g.service} (${g.missing.join(', ')})`).join('; ');
}

module.exports = { gaps, describe, servicesOf };
