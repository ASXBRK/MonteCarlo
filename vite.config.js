import { defineConfig } from "vite";

// This app is proxied under the /projections subpath at
// bradenk.ing/projections. Trailing slash matters: without it, Vite
// treats the base as a filename prefix rather than a path.
//
// The BalancePoint sibling branch adds @vitejs/plugin-react + a
// vitest config; those get merged in when that branch lands. On this
// vanilla-JS branch we deliberately do NOT apply the React plugin —
// it injects react-refresh preambles that expect React to be present
// at runtime and break the client-side boot.
export default defineConfig({
  base: "/projections/",
});
