import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    watch: false,
    globals: true,
    reporters: ["default"],
    bail: 1,
  },
});
