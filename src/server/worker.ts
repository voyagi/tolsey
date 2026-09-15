import {
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  originValidationResponse,
} from '@modelcontextprotocol/server';

export interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ALLOWED_HOSTNAMES: string;
}

export const SERVER_INFO = { name: 'tolsey', version: '0.1.0' };

export function createServer(): McpServer {
  return new McpServer(SERVER_INFO);
}

const mcp = createMcpHandler(() => createServer());

function allowedHostnames(env: WorkerEnv): string[] {
  return env.ALLOWED_HOSTNAMES.split(',').map((name) => name.trim()).filter(Boolean);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (new URL(request.url).pathname !== '/mcp') return env.ASSETS.fetch(request);
    // The handler does no Host or Origin checks of its own, so a page on another site could
    // otherwise drive this endpoint from a cook's browser (DNS rebinding).
    const allowed = allowedHostnames(env);
    const rejected =
      hostHeaderValidationResponse(request, allowed) ?? originValidationResponse(request, allowed);
    return rejected ?? mcp.fetch(request);
  },
};
