import { McpServer } from '@modelcontextprotocol/server';
import type { KitchenRow, Store } from '../store/port';

export interface Clock {
  now(): number;
}

export interface ServerDeps {
  store: Store;
  clock: Clock;
  kitchen: KitchenRow;
}

export const SERVER_INFO = { name: 'tolsey', version: '0.1.0' };

export function createServer(_deps: ServerDeps): McpServer {
  return new McpServer(SERVER_INFO, { capabilities: { tools: { listChanged: false } } });
}
