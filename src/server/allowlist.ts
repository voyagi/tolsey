// No imports on purpose: the deploy preflight loads this file straight from Node, so the list the
// preflight clears is exactly the list the Worker accepts.

export type AllowlistParse = { ok: true; hostnames: string[] } | { ok: false; reason: string };

const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/;
const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// The SDK compares a request's hostname against the list exactly, so an entry that no Host header
// can equal (a scheme, a path, a port, a wildcard, a non-ASCII name, a trailing dot) would silently
// lock every visitor out; a bad list is refused loudly instead.
function entryProblem(entry: string): string | null {
  if (entry === '') return 'is empty: remove the stray comma';
  if (entry.includes('://')) return 'is a URL: give the bare hostname';
  if (entry.includes('/')) return 'holds a path: give the bare hostname';
  if (/\s/.test(entry)) return 'holds whitespace';
  if (entry.startsWith('[')) return IPV6_LITERAL.test(entry) ? null : 'is not a bracketed IPv6 literal';
  if (entry.includes(':')) return 'holds a port: give the hostname without it';
  if (entry.includes('*')) return 'holds a wildcard: list every hostname, because the check matches exactly';
  if (!entry.split('.').every((label) => HOSTNAME_LABEL.test(label))) {
    return 'is not an ASCII hostname: use letters, digits, inner hyphens and dots, and give a non-ASCII name in its punycode form';
  }
  return null;
}

export function parseAllowlist(raw: string | undefined): AllowlistParse {
  if (raw === undefined || raw.trim() === '') {
    return { ok: false, reason: 'ALLOWED_HOSTNAMES is not set: list the hostnames this Worker answers, comma separated' };
  }
  const hostnames = raw.split(',').map((entry) => entry.trim().toLowerCase());
  for (const entry of hostnames) {
    const problem = entryProblem(entry);
    if (problem) return { ok: false, reason: `ALLOWED_HOSTNAMES entry "${entry}" ${problem}` };
  }
  return { ok: true, hostnames };
}
