// Architecture-boundary rules = externalized memory (the rule file IS the documented architecture).
// NARROW: only boundaries that genuinely must not be crossed, each an error. EDIT the path regexes
// to the product's real layers; keep the set small and meaningful (a wall nobody respects is noise).
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  forbidden: [
    {
      name: 'no-ui-to-server',
      severity: 'error',
      // SECURITY-RELEVANT + LAYOUT-SPECIFIC. These regexes assume an src/ui|client|components vs
      // src/server split. If they match NO files (a different layout - app/, apps/web/, lib/server),
      // depcruise reports 0 violations and this protection SILENTLY does not apply (false assurance).
      // ALWAYS adapt the paths to the real layers AND smoke-test it (plant a ui->server import, see it
      // fail). Do NOT just broaden to `app/ -> server/`: a Next.js app/ legitimately imports server
      // code (server components / route handlers), so that would false-positive instead.
      comment: 'Client/UI code must not import server-only modules (would leak secrets/Node APIs into the bundle).',
      from: { path: '^src/(ui|client|components)' },
      to: { path: '^src/server' },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment:
        'The domain decides from its arguments alone: it never reaches into storage or the Worker, so the same ' +
        'decision runs in any test, host or replay. Type-only imports are erased before this check sees them.',
      from: { path: '^src/domain', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(store|server)' },
    },
    {
      name: 'domain-reads-no-data',
      severity: 'error',
      comment:
        'Rule rows and the kitchen profile reach the domain as arguments from src/server/data.ts, never by ' +
        'import, so a limit is always the one the server loaded and validated (RULE-01). Tests may read the data.',
      from: { path: '^src/domain', pathNot: '\\.test\\.ts$' },
      to: { path: '^data/' },
    },
    {
      name: 'judge-never-reads-rules',
      severity: 'error',
      comment:
        'The judge compares a reading with the limit it is handed and nothing else. It stays blind to the rule ' +
        'table, the loaded data and how sources are shown even if the domain-wide data rule is ever relaxed.',
      from: { path: '^src/domain/judge', pathNot: '\\.test\\.ts$' },
      to: { path: '^(data/|src/(server/data|domain/citation))' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make code hard to reason about, test, and tree-shake.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan modules (imported by nothing) are usually dead code - confirm or delete.',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)(index|main|entry)\\.[jt]sx?$', '\\.config\\.[jt]s$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // tsConfig ONLY when the project actually has one (it improves TS path-alias resolution).
    // Hardcoding it makes depcruise ERROR "Cannot read file 'tsconfig.json'" and exit 1 on a
    // JS-only product (verified 2026-06-25). Resolve against __dirname (the config's own dir =
    // product root), not a cwd-relative name, so the check is correct no matter where depcruise is
    // invoked from (a subdirectory, a monorepo package).
    ...(fs.existsSync(path.join(__dirname, 'tsconfig.json'))
      ? { tsConfig: { fileName: path.join(__dirname, 'tsconfig.json') } }
      : {}),
    enhancedResolveOptions: { extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'] },
  },
};
