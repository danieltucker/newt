import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';

// Single source of truth for the app version - surfaced in the console's
// `version` command via the __APP_VERSION__ define below
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // The server-rendered document routes, mirroring the location block in
      // client/nginx.conf. Without these, dev is the one place where a public
      // URL does *not* describe itself: Vite hands back the raw index.html, so a
      // Newt link pasted into the editor previews as the app's tagline and a
      // link shared out of dev unfurls as a blank card - neither of which is a
      // bug in the page being linked to, and both of which look exactly like
      // one. Keeping the two in step is the whole point.
      //
      // Regex keys, not prefixes: '/s' as a plain prefix would swallow
      // /src/main.tsx, /shots and /svg, and the entry script going through the
      // API proxy is a blank dev server with no obvious cause. The trailing
      // slash is what makes each of these unambiguous.
      //
      // Express fetches the shell back from this same dev server to inject into
      // (see SHELL_ORIGIN in server/src/lib/htmlShell.ts). /index.html is not
      // matched here, so that sub-request is served from disk and there is no
      // loop.
      '^/(u|a|t|e|s)/': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '^/(recent|robots\\.txt|sitemap[a-z0-9-]*\\.xml)$': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
