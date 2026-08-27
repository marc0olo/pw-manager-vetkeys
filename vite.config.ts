import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Canisters whose IDs the dev server should publish through the `ic_env` cookie.
const CANISTER_NAMES = ["backend", "frontend"];

// `icp deploy` exports this to presync steps; a human can set it to point
// `npm run dev` at another environment.
const ENVIRONMENT = process.env.ICP_CLI_ENVIRONMENT ?? "local";

function icp(command: string): string {
  return execSync(`icp ${command}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * In production the frontend canister sets the `ic_env` cookie on every HTML
 * response. `vite dev` has to fake it: same cookie, same shape, values read live
 * from the running local network so nothing is hardcoded.
 *
 * It also publishes DEV_GATEWAY_ORIGIN, which production has no need for: the
 * dev server runs on its own port, so the page's own origin is not the gateway
 * and the app cannot locate the local Internet Identity from it. Deployed builds
 * are served by the gateway and derive it from `window.location` instead.
 */
function devServerConfig() {
  try {
    const status: { api_url: string; gateway_url: string; root_key: string } = JSON.parse(
      icp(`network status -e ${ENVIRONMENT} --json`),
    );
    const vars = [
      ...CANISTER_NAMES.map(
        (name) => `PUBLIC_CANISTER_ID:${name}=${icp(`canister status ${name} -e ${ENVIRONMENT} --id-only`)}`,
      ),
      `DEV_GATEWAY_ORIGIN=${new URL(status.gateway_url).origin}`,
      `ic_root_key=${status.root_key}`,
    ];

    return {
      headers: { "Set-Cookie": `ic_env=${encodeURIComponent(vars.join("&"))}; SameSite=Lax; Path=/` },
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
