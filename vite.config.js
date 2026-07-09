import { defineConfig } from "vite";

// This app is proxied under the /projections subpath at
// bradenk.ing/projections. Trailing slash matters: without it, Vite
// treats the base as a filename prefix rather than a path.
export default defineConfig({
  base: "/projections/",
});
