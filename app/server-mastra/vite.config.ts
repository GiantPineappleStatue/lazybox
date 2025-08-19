import { defineConfig } from "vite";

// Minimal Vite config to isolate Vitest in this package and avoid parent app plugins
export default defineConfig({
  plugins: [],
  build: {
    target: "node20",
    sourcemap: false,
    outDir: "dist"
  },
});
