# Tolsey

A food safety log for small restaurant kitchens that you fill in by voice. Say the reading, and it
lands in the day's record against the rule that applies. A reading outside the rule opens a
corrective action with a deadline. A check with no number is refused.

Tolsey is an MCP server (spec 2025-11-25, Streamable HTTP) built for Alexa+, with a simulated
Alexa+ screen in the browser.

Status: early development. Nothing here is deployed yet.

## Setup

Requirements: Node.js 24 or newer, npm.

```sh
npm install
cp .env.example .dev.vars
npm run dev
```

## Checks

```sh
npm run gate          # types, lint, duplication, dependency rules, env parity
npm run verify:ship   # the full check before anything ships
```

## License

MIT, see [LICENSE](LICENSE).
