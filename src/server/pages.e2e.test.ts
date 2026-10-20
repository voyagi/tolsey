import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtWorkerHarness } from '../test-support/target';

const AP_COMPLAINT_URL = 'https://www.autoriteitpersoonsgegevens.nl/en/submitting-a-tip-off-or-a-complaint-to-the-ap';
const BUILT_PAGES = ['dist/client/index.html', 'dist/client/privacy.html'];
const SITE = 'https://tolsey.taranity.com';
const BUILT_CARD = 'dist/client/card.png';

// The three icon links as Evil Martians' favicon guide gives them, in this order on both pages.
const ICON_LINKS = [
  { rel: 'icon', href: '/favicon.ico', sizes: '32x32' },
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
];

// Every file a link preview or a browser tab fetches. With the single-page fallback a missing one
// still answers 200, with the wall's HTML, so the content type is what proves the file is there.
const PREVIEW_FILES = ['/card.png', '/favicon.svg', '/favicon.ico', '/apple-touch-icon.png'];

// Each GDPR Article 13 element DEMO-06 names, with the words the notice must carry for it. The logs
// line follows docs/privacy-accountability.md, which keeps "may still hold" for the kitchen id.
const DEMO_06_ELEMENTS: readonly (readonly [string, string])[] = [
  ['the controller', 'Taranity'],
  ['the contact address', 'support@taranity.com'],
  ['IP addresses', 'IP addresses'],
  ['IP addresses only in transit', 'in transit'],
  ['visitor demo writes', 'scratch kitchen'],
  ['the theme choice kept in the browser', 'theme choice'],
  ['the input channel', 'typed into the field or picked from a phrase'],
  ['where: Cloudflare', 'Cloudflare'],
  ['how long demo writes are kept', '24 hours'],
  ['how long a log line is kept', '3 days'],
  ['what a log line may still hold', 'may still hold'],
  ['how to ask for deletion', 'To ask for deletion'],
  ['the legal basis', 'Article 6(1)(f)'],
  ['the first legitimate interest', 'showing the product to a visitor who chose to try it'],
  ['the second legitimate interest', 'delivering and protecting each request'],
  ['the processor in the US', 'Cloudflare, Inc. is in the US'],
  ['the Customer DPA version', 'Customer DPA, version 6.4'],
  ['the Standard Contractual Clauses', 'EU Standard Contractual Clauses'],
  ['their DPA clause', 'clause 6.2(a)'],
  ['the Data Privacy Framework', 'EU-U.S. Data Privacy Framework'],
  ['its DPA clause', 'clause 6.4'],
  ['the right of access', 'access to'],
  ['the right to rectification', 'rectification'],
  ['the right to restriction', 'restriction of processing'],
  ['the right to portability', 'portability'],
  ['the right to object', 'object to'],
  ['the right to erasure', 'erasure'],
  ['the Article 11 note', 'Article 11'],
  ['the supervisory authority', 'Autoriteit Persoonsgegevens'],
  ['the complaint address, verbatim', AP_COMPLAINT_URL],
  ['no automated decision', 'No automated decision is made about a person'],
  ['the accessibility statement', 'WCAG 2.2'],
  ['the browser keeps only the theme choice', 'This browser keeps only your theme choice'],
];

function textOf(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ');
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

function sha256Source(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

function directive(csp: string, name: string): string {
  return csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? '';
}

// Each <meta> or <link> tag of a page as its attributes, so a check reads one tag whatever the
// attribute order.
function tagsOf(html: string, tag: 'meta' | 'link'): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((match) =>
    Object.fromEntries([...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((attribute) => [attribute[1], attribute[2]])),
  );
}

function metaContents(html: string, key: 'property' | 'name', value: string): string[] {
  return tagsOf(html, 'meta').filter((tag) => tag[key] === value).map((tag) => tag.content);
}

// A PNG's width and height sit in its IHDR chunk, right after the 8-byte signature and the chunk's
// length and type.
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('the static pages and their headers (built Worker in workerd)', () => {
  let harness: ReturnType<typeof builtWorkerHarness>;
  let baseUrl: URL;

  beforeAll(async () => {
    harness = builtWorkerHarness();
    ({ url: baseUrl } = await harness.listen());
    await harness.getWorker().applyD1Migrations('DB');
  });

  afterAll(async () => {
    await harness?.close();
  });

  async function headersOf(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(new URL(path, baseUrl), { redirect: 'manual', ...init });
    await response.body?.cancel();
    return response;
  }

  it.each(['/', '/privacy'])('serves %s with the CSP, nosniff and no-referrer headers', async (path) => {
    const response = await headersOf(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('serves /privacy as its own page, never the wall', async () => {
    const response = await fetch(new URL('/privacy', baseUrl));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain('id="root"');
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toContain('href="/"');
  });

  it.each(DEMO_06_ELEMENTS)('says %s in the privacy notice', async (_name, words) => {
    const html = await (await fetch(new URL('/privacy', baseUrl))).text();
    expect(textOf(html)).toContain(words);
  });

  it('links the complaint address exactly as the authority publishes it', async () => {
    const html = await (await fetch(new URL('/privacy', baseUrl))).text();
    expect(html).toContain(`href="${AP_COMPLAINT_URL}"`);
  });

  it('answers /privacy/ with a 307 to /privacy', async () => {
    const response = await headersOf('/privacy/');
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/privacy');
  });

  it('allows the one pre-paint script by its hash, the same bytes on both pages, and no inline script otherwise', async () => {
    const scripts = BUILT_PAGES.map((page) => inlineScripts(readFileSync(page, 'utf8')));
    for (const found of scripts) expect(found).toHaveLength(1);
    expect(scripts[1][0]).toBe(scripts[0][0]);

    const csp = (await headersOf('/')).headers.get('content-security-policy') ?? '';
    const scriptSrc = directive(csp, 'script-src');
    expect(scriptSrc).toContain(sha256Source(scripts[0][0]));
    expect(scriptSrc.match(/'sha256-/g)).toHaveLength(1);
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
  });

  it('loads every script, stylesheet and font of both pages from its own origin', () => {
    for (const page of BUILT_PAGES) {
      const html = readFileSync(page, 'utf8');
      const sources = [...html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]*)"/g)].map((match) => match[1]);
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) expect(source).toMatch(/^\/(?!\/)/);
    }
  });

  it('gives the wall a link preview whose image is the card at its full address and real size', () => {
    const html = readFileSync(BUILT_PAGES[0], 'utf8');
    expect(metaContents(html, 'property', 'og:type')).toEqual(['website']);
    expect(metaContents(html, 'property', 'og:url')).toEqual([`${SITE}/`]);
    expect(metaContents(html, 'property', 'og:image')).toEqual([`${SITE}/card.png`]);
    const card = pngSize(BUILT_CARD);
    expect(metaContents(html, 'property', 'og:image:width')).toEqual([String(card.width)]);
    expect(metaContents(html, 'property', 'og:image:height')).toEqual([String(card.height)]);
    expect(card).toEqual({ width: 1600, height: 900 });
    expect(metaContents(html, 'name', 'twitter:card')).toEqual(['summary_large_image']);
    for (const property of ['og:title', 'og:description', 'og:image:alt']) {
      const found = metaContents(html, 'property', property);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/\S/);
    }
  });

  it.each(BUILT_PAGES)('links the three site icons from %s', (page) => {
    const links = tagsOf(readFileSync(page, 'utf8'), 'link').filter((tag) => tag.rel === 'icon' || tag.rel === 'apple-touch-icon');
    expect(links).toEqual(ICON_LINKS);
  });

  it.each(PREVIEW_FILES)('serves %s as an image, never the wall', async (path) => {
    const response = await headersOf(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^image\//);
  });

  it('leaves the Worker its own headers on /api and /mcp answers', async () => {
    const api = await headersOf('/api/kitchens');
    expect(api.status).toBe(405);
    expect(api.headers.get('content-security-policy')).toBeNull();

    const mcp = await headersOf('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pages-test', version: '1' } },
      }),
    });
    expect(mcp.status).toBe(200);
    expect(mcp.headers.get('content-security-policy')).toBeNull();
  });
});
