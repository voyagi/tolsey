import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The deployed list names only the deployed host, so a page on a loopback origin can never drive the
// public Worker. The dev server alone answers on localhost; the customizer is never applied to a build,
// so these names cannot reach dist/tolsey/wrangler.json, which is what deploys.
const DEV_ONLY_VARS = { ALLOWED_HOSTNAMES: 'localhost,127.0.0.1' };

export default defineConfig(({ command, isPreview }) => ({
  plugins: [react(), cloudflare(command === 'serve' && !isPreview ? { config: { vars: DEV_ONLY_VARS } } : {})],
}));
