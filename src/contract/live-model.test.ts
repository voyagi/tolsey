import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as liveModel from './live-model';
import { LIVE_MODEL_DISCLOSURE } from './live-model';

describe('the live-model disclosure (AI Act Article 50(1))', () => {
  it('tells the person they are talking to an AI system, first', () => {
    expect(LIVE_MODEL_DISCLOSURE).toMatch(/^You are talking to an AI system\./);
  });

  it('is one plain spoken sentence or two, with no markdown and no degree sign', () => {
    expect(LIVE_MODEL_DISCLOSURE.trim()).toBe(LIVE_MODEL_DISCLOSURE);
    expect(LIVE_MODEL_DISCLOSURE).toMatch(/^[A-Z][^\n]*\.$/);
    expect(LIVE_MODEL_DISCLOSURE).not.toMatch(/[*_`#[\]<>|~]/);
    expect(LIVE_MODEL_DISCLOSURE).not.toContain('°');
  });

  it('is the single exported disclosure', () => {
    expect(Object.keys(liveModel)).toEqual(['LIVE_MODEL_DISCLOSURE']);
  });
});

// docs/ai-act.md decides every Article 50 paragraph DOES NOT APPLY because nothing calls a model by
// default, and says 50(1) is decided again once a model arrives. Nothing rereads a document on its own,
// so the arrival fails here instead. The lists are a floor, the model clients this stack could
// plausibly pull in, never every one that exists.
const MODEL_CLIENTS: ReadonlySet<string> = new Set([
  'ai', 'cohere-ai', 'groq-sdk', 'langchain', 'ollama', 'openai', 'replicate', 'workers-ai-provider',
  '@aws-sdk/client-bedrock-runtime', '@google/genai', '@google/generative-ai', '@huggingface/inference',
  '@mistralai/mistralai',
]);
const MODEL_CLIENT_SCOPES = ['@ai-sdk/', '@anthropic-ai/', '@langchain/'];
// The Workers AI binding is an "ai" block in the Worker config.
const AI_BINDING = /"ai"\s*:/;

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function isModelClient(name: string): boolean {
  return MODEL_CLIENTS.has(name) || MODEL_CLIENT_SCOPES.some((scope) => name.startsWith(scope));
}

// A dev dependency counts too: Vite bundles whatever the Worker imports, whichever list names it.
function modelCallers(manifestText: string, wranglerText: string): string[] {
  const manifest = JSON.parse(manifestText) as Manifest;
  const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
  const clients = names.filter(isModelClient);
  return AI_BINDING.test(wranglerText) ? [...clients, 'the Workers AI binding in wrangler.jsonc'] : clients;
}

describe('the default configuration calls no model (AI Act Article 50 rests on it)', () => {
  it('has no model client among the dependencies and no Workers AI binding', () => {
    const manifestText = readFileSync('package.json', 'utf8');
    const wranglerText = readFileSync('wrangler.jsonc', 'utf8');
    // An empty answer from the wrong files would read as clean, so the files are this repo's first.
    expect(Object.keys((JSON.parse(manifestText) as Manifest).dependencies ?? {})).toContain('@modelcontextprotocol/server');
    expect(wranglerText).toMatch(/"main":\s*"src\/server\/worker\.ts"/);
    const callers = modelCallers(manifestText, wranglerText);
    expect(callers, 'a model arrived: decide docs/ai-act.md again and show LIVE_MODEL_DISCLOSURE first').toEqual([]);
  });

  it('names a model client or a Workers AI binding when one is added', () => {
    const manifest = JSON.stringify({ dependencies: { react: '19.2.0', openai: '6.0.0' }, devDependencies: { '@ai-sdk/openai': '2.0.0' } });
    expect(modelCallers(manifest, '{ "ai": { "binding": "AI" } }')).toEqual([
      'openai',
      '@ai-sdk/openai',
      'the Workers AI binding in wrangler.jsonc',
    ]);
  });

  it('names nothing for a manifest and a Worker config with no model in them', () => {
    const manifest = JSON.stringify({ dependencies: { react: '19.2.0', zod: '4.6.0' }, devDependencies: { vitest: '5.0.0' } });
    expect(modelCallers(manifest, '{ "name": "tolsey", "d1_databases": [] }')).toEqual([]);
  });
});
