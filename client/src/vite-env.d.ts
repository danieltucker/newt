/// <reference types="vite/client" />

// The app version, injected at build time from client/package.json by the
// `define` in vite.config.ts. That package.json is the single source of truth -
// nothing should hardcode a version string or keep its own copy.
//
// Declared once, here, so every component can just use it. It used to be
// re-declared in each file that referenced it, which is how NewTabPage ended up
// carrying a declaration for a constant it never used.
declare const __APP_VERSION__: string;
