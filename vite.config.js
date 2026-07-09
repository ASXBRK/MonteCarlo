import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Deployed under /projections at bradenk.ing/projections. Trailing
// slash matters: without it Vite treats the base as a filename prefix
// rather than a path.
export default defineConfig({
  base: "/projections/",
  plugins: [react()],
  test: {
    environment: "node",
    globals: false,
  },
});
