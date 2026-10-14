# Tolsey

A food safety log for small restaurant kitchens that you fill in by voice. Say the reading, and it
lands in the day's record against the rule that applies. A reading outside the rule opens a
corrective action with a deadline. A check with no number is refused.

Tolsey is an MCP server (spec 2025-11-25, Streamable HTTP) built for Alexa+, with a simulated
Alexa+ screen in the browser.

Status: early development. Nothing here is deployed yet.

## Setup

Requirements: Node.js 24.11 or newer with npm 11.18 or newer (Node 24.20 and later bundle it).

```sh
npm ci --ignore-scripts
npm rebuild esbuild workerd
cp .env.example .dev.vars
npm run dev
```

The install runs with scripts off, then builds only the two packages that need their install step,
so no other dependency's install script runs, whatever the npm version. With npm 11.18 or newer a
plain `npm install` is held to the same two by `allowScripts` in `package.json`. An older npm only
warns about its version there and runs every install script.

## Checks

```sh
npm run gate          # types, lint, duplication, dependency rules, env parity
npm run verify:ship   # the full check before anything ships
```

## License

MIT, see [LICENSE](LICENSE).
