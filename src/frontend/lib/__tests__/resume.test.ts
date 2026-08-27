import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The load-time gate: which stored sessions may be resumed, and that a refusal
 * always purges the delegation *and* the cached key material together.
 */

const PRINCIPAL = "aaaaa-bbbbb-ccccc-ddddd-cai";
const OTHER = "zzzzz-yyyyy-xxxxx-wwwww-cai";

// --- stub the identity provider client -------------------------------------
type SignInOptions = { maxTimeToLive?: bigint; targets?: unknown[] };

const authState = {
  authenticated: false,
  principal: PRINCIPAL,
  anonymous: false,
  signOutCalls: 0,
  signOutThrows: false,
  signInOptions: undefined as SignInOptions | undefined,
};

vi.mock("@icp-sdk/auth/client", () => ({
  AuthClient: class {
    idleManager = undefined;
    isAuthenticated() {
      return authState.authenticated;
    }
    async getIdentity() {
      return {
        getPrincipal: () => ({
          toText: () => authState.principal,
          isAnonymous: () => authState.anonymous,
        }),
      };
    }
    async signOut() {
      authState.signOutCalls++;
      authState.authenticated = false;
      if (authState.signOutThrows) throw new Error("storage unavailable");
    }
    async signIn(options?: SignInOptions) {
      authState.signInOptions = options;
      authState.authenticated = true;
      return {
        getPrincipal: () => ({
          toText: () => authState.principal,
          isAnonymous: () => authState.anonymous,
        }),
      };
    }
  },
}));

const { resumeSession, signIn, signOut } = await import("../auth");
const { IDLE_TIMEOUT_MS, keyCacheName, markActive } = await import("../session");

function openKeyStore(principal: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(keyCacheName(principal), 1);
    request.onupgradeneeded = () => request.result.createObjectStore("k");
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

async function keyStoreExists(principal: string): Promise<boolean> {
  return (await indexedDB.databases()).some((d) => d.name === keyCacheName(principal));
}

/** Put the world in the state a page load would find it in. */
async function given({
  markAgeMs,
  markPrincipal = PRINCIPAL,
  authenticated,
  anonymous = false,
}: {
  markAgeMs: number | null;
  markPrincipal?: string;
  authenticated: boolean;
  anonymous?: boolean;
}) {
  window.localStorage.clear();
  if (markAgeMs !== null) {
    markActive(markPrincipal);
    window.localStorage.setItem("vetvault:last-active", String(Date.now() - markAgeMs));
  }
  authState.authenticated = authenticated;
  authState.anonymous = anonymous;
  authState.principal = PRINCIPAL;
  authState.signOutCalls = 0;
  authState.signOutThrows = false;
  await openKeyStore(PRINCIPAL);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("resumeSession", () => {
  it("resumes a session inside the idle window", async () => {
    await given({ markAgeMs: 60_000, authenticated: true });

    const { identity, lockReason } = await resumeSession();

    expect(identity).not.toBeNull();
    expect(lockReason).toBeNull();
    // The cache must survive — that is the whole point of persisting it.
    expect(await keyStoreExists(PRINCIPAL)).toBe(true);
  });

  it("refuses a session left idle past the timeout, and purges the key store", async () => {
    await given({ markAgeMs: IDLE_TIMEOUT_MS + 1_000, authenticated: true });

    const { identity, lockReason } = await resumeSession();

    expect(identity).toBeNull();
    expect(lockReason).toBe("idle");
    expect(authState.signOutCalls).toBe(1);
    expect(await keyStoreExists(PRINCIPAL)).toBe(false);
  });

  it("refuses when the delegation is gone even if the mark is fresh", async () => {
    // Key material must never outlive the session that authorised it.
    await given({ markAgeMs: 0, authenticated: false });

    const { identity, lockReason } = await resumeSession();

    expect(identity).toBeNull();
    expect(lockReason).toBe("expired");
    expect(await keyStoreExists(PRINCIPAL)).toBe(false);
  });

  it("refuses when there is no mark at all, and says why", async () => {
    await given({ markAgeMs: null, authenticated: true });

    const { identity, lockReason } = await resumeSession();

    expect(identity).toBeNull();
    expect(lockReason).toBe("expired");
    expect(await keyStoreExists(PRINCIPAL)).toBe(false);
  });

  it("gives no lock reason on a genuinely first visit", async () => {
    await given({ markAgeMs: null, authenticated: false });

    const { identity, lockReason } = await resumeSession();

    expect(identity).toBeNull();
    expect(lockReason).toBeNull(); // nothing was torn down; do not alarm the user
  });

  // The reviewer's demonstration: a mark already past the timeout, then a
  // backwards clock jump, used to resume a session that should have been refused.
  it("refuses a session whose staleness a backwards clock has hidden", async () => {
    await given({ markAgeMs: -20 * 60_000, authenticated: true }); // mark in the future

    const { identity, lockReason } = await resumeSession();

    expect(identity).toBeNull();
    expect(lockReason).toBe("expired");
    expect(await keyStoreExists(PRINCIPAL)).toBe(false);
  });

  it("still resumes across clock skew within tolerance", async () => {
    await given({ markAgeMs: -5_000, authenticated: true });

    const { identity, lockReason } = await resumeSession();

    expect(identity).not.toBeNull();
    expect(lockReason).toBeNull();
  });

  it("refuses when the mark belongs to a different principal", async () => {
    await given({ markAgeMs: 60_000, markPrincipal: OTHER, authenticated: true });

    const { identity, lockReason } = await resumeSession();

    expect(identity).toBeNull();
    expect(lockReason).toBe("expired");
  });

  it("refuses an anonymous identity", async () => {
    await given({ markAgeMs: 60_000, authenticated: true, anonymous: true });

    const { identity, lockReason } = await resumeSession();

    expect(identity).toBeNull();
    expect(lockReason).toBe("expired");
    expect(await keyStoreExists(PRINCIPAL)).toBe(false);
  });
});

describe("signOut", () => {
  it("purges key material, the delegation and the mark", async () => {
    await given({ markAgeMs: 0, authenticated: true });

    await signOut();

    expect(authState.signOutCalls).toBe(1);
    expect(window.localStorage.getItem("vetvault:last-active")).toBeNull();
    expect(window.localStorage.getItem("vetvault:principal")).toBeNull();
    expect(await keyStoreExists(PRINCIPAL)).toBe(false);
  });

  it("still clears the mark when the delegation store throws", async () => {
    // The dangerous direction is failing halfway and leaving a mark that makes a
    // dead session look live.
    await given({ markAgeMs: 0, authenticated: true });
    authState.signOutThrows = true;

    await expect(signOut()).rejects.toThrow("storage unavailable");

    expect(window.localStorage.getItem("vetvault:last-active")).toBeNull();
    expect(await keyStoreExists(PRINCIPAL)).toBe(false);
  });
});

describe("signIn", () => {
  // Internet Identity does not issue canister-scoped delegations: it ignores a
  // `targets` request and returns an unscoped chain, which @icp-sdk/signer then
  // rejects with "Returned delegation is unscoped but scoped targets were
  // requested" — sign-in fails outright. This was shipped once and only surfaced
  // in a manual test, because the canister happily accepts a scoped delegation;
  // it is the issuer that will not make one.
  it("does not request scoped targets", async () => {
    window.localStorage.clear();
    authState.anonymous = false;

    await signIn();

    expect(authState.signInOptions).toBeDefined();
    expect(authState.signInOptions?.targets).toBeUndefined();
  });

  it("requests the delegation lifetime from SESSION_POLICY", async () => {
    const { SESSION_POLICY } = await import("../session");
    window.localStorage.clear();
    authState.anonymous = false;

    await signIn();

    expect(authState.signInOptions?.maxTimeToLive).toBe(
      BigInt(SESSION_POLICY.delegationHours) * BigInt(3_600_000_000_000),
    );
  });

  it("marks the session live so the next load can resume it", async () => {
    window.localStorage.clear();
    authState.anonymous = false;

    await signIn();

    expect(window.localStorage.getItem("vetvault:principal")).toBe(PRINCIPAL);
  });
});
