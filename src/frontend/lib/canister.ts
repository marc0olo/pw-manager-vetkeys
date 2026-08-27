import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";

/**
 * The vault canister's ID, injected by `icp deploy` into every canister's
 * settings and delivered to the frontend through the `ic_env` cookie.
 */
export function backendCanisterId(): string {
  const id = safeGetCanisterEnv<{ readonly "PUBLIC_CANISTER_ID:backend": string }>()?.[
    "PUBLIC_CANISTER_ID:backend"
  ];
  if (!id) {
    throw new Error(
      "Backend canister ID missing from the ic_env cookie. Deploy with `icp deploy`, " +
        "or start the local network before `npm run dev`.",
    );
  }
  return id;
}
