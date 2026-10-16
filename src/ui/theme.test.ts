/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThemeSwitch } from './ThemeSwitch';

const INDEX_HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const KEY = 'tolsey-theme';

// A classic inline script has no src and is not a module: those are what run before first paint,
// and what the page's CSP hashes. The test runs the page's own script text, never a copy of it.
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes]) => !/\bsrc=/.test(attributes) && !/type="module"/.test(attributes))
    .map(([, , body]) => body);
}

type Listener = (event: { detail: unknown }) => void;

interface PageOptions {
  stored?: Record<string, string>;
  search?: string;
  osDark?: boolean;
  getThrows?: boolean;
  setThrows?: boolean;
}

function openPage({ stored = {}, search = '', osDark = false, getThrows = false, setThrows = false }: PageOptions = {}) {
  const attributes = new Map<string, string>();
  const store = new Map(Object.entries(stored));
  const writes: string[] = [];
  const documentListeners = new Map<string, Listener[]>();
  const osListeners: (() => void)[] = [];
  const media = {
    matches: osDark,
    addEventListener(type: string, listener: () => void) {
      if (type === 'change') osListeners.push(listener);
    },
  };
  const storage = {
    getItem(key: string): string | null {
      if (getThrows) throw new Error('storage blocked');
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (setThrows) throw new Error('storage blocked');
      writes.push(key);
      store.set(key, String(value));
    },
  };
  const documentStub = {
    documentElement: {
      dataset: {},
      setAttribute(name: string, value: string) {
        attributes.set(name, String(value));
      },
    },
    addEventListener(type: string, listener: Listener) {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
    },
  };
  const context = createContext({
    document: documentStub,
    window: { matchMedia: () => media, localStorage: storage },
    localStorage: storage,
    location: { search },
    URLSearchParams,
  });
  for (const script of inlineScripts(INDEX_HTML)) runInContext(script, context);
  return {
    theme: () => attributes.get('data-theme'),
    choice: () => attributes.get('data-theme-choice'),
    store,
    writes,
    choose(detail: unknown) {
      for (const listener of documentListeners.get('tolsey-theme') ?? []) listener({ detail });
    },
    setOsDark(dark: boolean) {
      media.matches = dark;
      for (const listener of osListeners) listener();
    },
  };
}

describe('the pre-paint theme script in index.html', () => {
  it.fails('index.html holds exactly one classic inline script', () => {
    expect(inlineScripts(INDEX_HTML)).toHaveLength(1);
  });

  it.fails('with nothing stored and a light OS the page is light, the choice device', () => {
    const page = openPage();
    expect(page.theme()).toBe('light');
    expect(page.choice()).toBe('device');
  });

  it.fails('with nothing stored and a dark OS the page is dark, the choice device, and it follows the OS', () => {
    const page = openPage({ osDark: true });
    expect(page.theme()).toBe('dark');
    page.setOsDark(false);
    expect(page.theme()).toBe('light');
    expect(page.choice()).toBe('device');
  });

  it.fails('a storage that throws on read gives device', () => {
    const page = openPage({ getThrows: true });
    expect(page.choice()).toBe('device');
    expect(page.theme()).toBe('light');
  });

  it.fails('an unknown stored value gives device', () => {
    const page = openPage({ stored: { [KEY]: 'blue' } });
    expect(page.choice()).toBe('device');
    expect(page.theme()).toBe('light');
  });

  it.fails('a stored dark is dark under a light OS and does not follow the OS', () => {
    const page = openPage({ stored: { [KEY]: 'dark' } });
    expect(page.theme()).toBe('dark');
    expect(page.choice()).toBe('dark');
    page.setOsDark(false);
    expect(page.theme()).toBe('dark');
  });

  it.fails('?theme=light overrides a stored dark for the view and stores nothing', () => {
    const page = openPage({ stored: { [KEY]: 'dark' }, search: '?theme=light' });
    expect(page.theme()).toBe('light');
    expect(page.choice()).toBe('light');
    expect(page.writes).toEqual([]);
    expect(page.store.get(KEY)).toBe('dark');
  });

  it.fails('a tolsey-theme event with detail light stores light and applies it', () => {
    const page = openPage({ osDark: true });
    page.choose('light');
    expect(page.store.get(KEY)).toBe('light');
    expect(page.theme()).toBe('light');
    expect(page.choice()).toBe('light');
  });

  it.fails('a tolsey-theme event still applies when storage throws on write', () => {
    const page = openPage({ setThrows: true });
    page.choose('dark');
    expect(page.theme()).toBe('dark');
    expect(page.choice()).toBe('dark');
  });

  it.fails('a tolsey-theme event with an unknown detail changes nothing and stores nothing', () => {
    const page = openPage();
    page.choose('blue');
    expect(page.choice()).toBe('device');
    expect(page.writes).toEqual([]);
  });

  it.fails('writes no key but tolsey-theme', () => {
    const page = openPage();
    page.choose('dark');
    page.choose('device');
    expect(page.writes).toEqual([KEY, KEY]);
    expect([...page.store.keys()]).toEqual([KEY]);
  });
});

describe('the theme switch', () => {
  const markup = renderToStaticMarkup(createElement(ThemeSwitch));
  const buttons = markup.match(/<button\b[^>]*>[^<]*<\/button>/g) ?? [];

  it.fails('offers Light, Dark and Device as buttons with exactly one pressed', () => {
    expect(buttons.map((button) => button.replace(/<[^>]*>/g, ''))).toEqual(['Light', 'Dark', 'Device']);
    expect(buttons.filter((button) => button.includes('aria-pressed="true"'))).toHaveLength(1);
    expect(buttons.filter((button) => button.includes('aria-pressed="false"'))).toHaveLength(2);
  });

  it.fails('says the choice is kept in this browser', () => {
    expect(markup).toContain('Kept in this browser');
  });
});
