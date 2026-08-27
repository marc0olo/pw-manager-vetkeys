import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Canisters whose IDs the dev server should publish through the `ic_env` cookie.
const CANISTER_NAMES = ["backend", "frontend"];
const ENVIRONMENT = process.env.ICP_ENVIRONMENT ?? "local";

function icp(command: string): string {
  return execSync(`icp ${command}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * In production the frontend canister sets the `ic_env` cookie on every HTML
 * response. `vite dev` has to fake it: same cookie, same shape, values read live
 * from the running local network so nothing is hardcoded.
 */
function devServerConfig() {
  try {
    const status = JSON.parse(icp(`network status -e ${ENVIRONMENT} --json`));
    const ids = CANISTER_NAMES.map(
      (name) => `PUBLIC_CANISTER_ID:${name}=${icp(`canister status ${name} -e ${ENVIRONMENT} --id-only`)}`,
    ).join("&");
    const icEnv = encodeURIComponent(`${ids}&ic_root_key=${status.root_key}`);

    return {
      headers: { "Set-Cookie": `ic_env=${icEnv}; SameSite=Lax; Path=/` },
      proxy: { "/api": { target: status.api_url, changeOrigin: true } },
    };
  } catch {
    // Network down or canisters not deployed yet — serve anyway so `vite dev`
    // still boots; the app will report that it cannot reach the vault.
    console.warn("[vite] no local ICP network reachable — run `icp network start -d && icp deploy` first");
    return {};
  }
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: command === "serve" ? devServerConfig() : undefined,
}));
