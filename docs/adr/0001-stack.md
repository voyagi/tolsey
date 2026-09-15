# 0001: Stack

Date: 2026-09-15. Status: accepted.

## Context

Tolsey is an MCP server for Alexa+ plus a browser screen that simulates the Alexa+ surface. The
Alexa+ MCP toolkit supports protocol version 2025-11-25 over Streamable HTTP, and it supports the
MCP Apps extension for visual cards. The server needs a public HTTPS endpoint, and the simulator,
the day sheet and the launch page are static client pages.

## Decision

- **Runtime and host: Cloudflare Workers with static assets.** One Worker serves `/mcp` and hands
  every other path to the asset binding (`run_worker_first: ["/mcp"]`, single-page-application
  fallback). The free tier covers a demo, and the Worker speaks web-standard `Request` and
  `Response`, which is what the MCP server package expects.
- **MCP: `@modelcontextprotocol/server` 2.x and `@modelcontextprotocol/ext-apps` 2.x.** Checked
  against the 2.0.0 packages on 2026-09-15: `@modelcontextprotocol/core` sets
  `LATEST_PROTOCOL_VERSION = "2025-11-25"` and lists it in `SUPPORTED_PROTOCOL_VERSIONS`, and
  `createMcpHandler` serves the 2026-07-28 revision while falling back to stateless serving for
  2025-era clients by default. `ext-apps` 2.0.0 types its server helpers against the 2.x server
  package, so the 1.x `@modelcontextprotocol/sdk` would mean an older MCP Apps line. The endpoint
  test in `src/server/worker.test.ts` pins the 2025-11-25 handshake.
- **Host and Origin checks in front of the handler.** `createMcpHandler` performs none, so the
  Worker checks both against `ALLOWED_HOSTNAMES` before dispatching.
- **Client: React 19 built with Vite 8 and `@cloudflare/vite-plugin`.** `ext-apps` ships React
  helpers for the card views, so the cards and the pages share one component model, and the plugin
  runs the Worker and the pages in one dev server.
- **TypeScript 6.0.x.** The npm `latest` tag is 7.x, the native port, whose JavaScript API is not
  stable yet, and `typescript-eslint` supports TypeScript below 6.1. Worker globals come from
  `wrangler types` (`worker-configuration.d.ts`); tests type-check with Node types in their own
  config.

## Alternatives considered

- `agents` (`McpAgent` on Durable Objects): built for sessionful servers. The tool set here is
  request and response, and stateless serving scales without a Durable Object per client.
- MCP SDK 1.x: stable, but it pairs with the older MCP Apps helpers.
- Astro or plain HTML for the pages: fine for the launch page, but the cards already need React,
  and one toolchain is simpler to keep green.

## Consequences

- Storage (D1 or Durable Objects) is decided in phase 1 with its own record.
- The 2.x MCP packages are two months old; a breaking change there shows up in the endpoint test.
- `ALLOWED_HOSTNAMES` must name the deployed hostname before the first deploy.
