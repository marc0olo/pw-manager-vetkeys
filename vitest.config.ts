import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/frontend/lib/__tests__/setup.ts"],
    include: ["src/frontend/**/*.test.ts", "src/frontend/**/*.test.tsx"],
  },
});
