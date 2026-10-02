// No imports on purpose: the deploy preflight loads this file straight from Node, so the list the
// preflight clears is exactly the list the Worker accepts.

export type AllowlistParse = { ok: true; hostnames: string[] } | { ok: false; reason: string };

const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/;
const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HOLDS_A_PORT = 'holds a port: give the hostname without it';
const NO_HOST_ADDRESS = 'is not an address a Host header can carry';

// The SDK compares the hostname a URL parser makes of the Host header, which writes an IPv6 literal
// compressed and an IPv4 address as four decimal parts, so an entry written any other way never matches.
function comparedFormProblem(entry: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(`http://${entry}`).hostname;
  } catch {
    return NO_HOST_ADDRESS;
  }
  return hostname === entry ? null : `is not the form a Host header is compared in: give ${hostname}`;
}

// A host and its port hold one colon and an IPv6 address holds at least two, so an entry with more
// is an address written without the brackets a Host header carries it in.
function unbracketedProblem(entry: string): string {
  try {
    return `is an IPv6 literal without its brackets: give ${new URL(`http://[${entry}]`).hostname}`;
  } catch {
    return NO_HOST_ADDRESS;
  }
}

// The SDK compares a request's hostname against the list exactly, so an entry that no Host header
// can equal (a scheme, a path, a port, a wildcard, a non-ASCII name, a trailing dot) would silently
// lock every visitor out; a bad list is refused loudly instead, naming the shape it found.
function entryProblem(entry: string): string | null {
  if (entry === '') return 'is empty: remove the stray comma';
  if (entry.includes('://')) return 'is a URL: give the bare hostname';
  if (entry.includes('/')) return 'holds a path: give the bare hostname';
  if (/\s/.test(entry)) return 'holds whitespace';
  if (entry.startsWith('[')) {
    if (entry.includes(']:')) return HOLDS_A_PORT;
    return IPV6_LITERAL.test(entry) ? comparedFormProblem(entry) : 'is not a bracketed IPv6 literal';
  }
  if (entry.split(':').length > 2) return unbracketedProblem(entry);
  if (entry.includes(':')) return HOLDS_A_PORT;
  if (entry.includes('*')) return 'holds a wildcard: list every hostname, because the check matches exactly';
  if (entry.endsWith('.')) return 'ends in a dot: give the hostname without it';
  if (!entry.split('.').every((label) => HOSTNAME_LABEL.test(label))) {
    return 'is not an ASCII hostname: use letters, digits, inner hyphens and dots, and give a non-ASCII name in its punycode form';
  }
  return comparedFormProblem(entry);
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
