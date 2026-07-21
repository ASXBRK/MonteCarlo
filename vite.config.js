import { defineConfig } from "vite";

// Relative base so the same build works in two deployment contexts:
//   - Direct Vercel preview at monte-carlo-*.vercel.app (root):
//     assets resolve to /assets/…
//   - Proxied under bradenk.ing/projections:
//     assets resolve to /projections/assets/…
//
// Using an absolute "/projections/" here would 404 the preview
// deployment; relative "./" hands the resolution to the browser
// against the HTML's own URL and works in both cases.
export default defineConfig({
  base: "./",
});
