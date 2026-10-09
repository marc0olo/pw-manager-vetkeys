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
  /** The record names a sign-in that has ended — `getStatus()` says `expired`. */
  expired: false,
  principal: PRINCIPAL,
  anonymous: false,
  signOutCalls: 0,
  signOutThrows: false,
  signInOptions: undefined as SignInOptions | undefined,
  getIdentityThrows: false,
};

vi.mock("@icp-sdk/auth/client", () => ({
  AuthClient: class {
    isAuthenticated() {
      return authState.authenticated;
    }
    getStatus() {
      if (authState.expired) return { state: "expired", expiresAtMs: Date.now() - 1 };
      return authState.authenticated
        ? { state: "signed-in", expiresAtMs: Date.now() + 3_600_000 }
        : { state: "signed-out" };
    }
    async getIdentity() {
      // A credential store that cannot be read, or a delegation that has to be
      // minted and cannot be.
      if (authState.getIdentityThrows) throw new Error("The database connection is closing");
      return {
        getPrincipal: () => ({
          toText: () => authState.principal,
          isAnonymous: () => authState.anonymous,
        }),
      };
    }
    async signOut() {
      authState.signOutCalls++;
      // Wiped first, then a failed revoke at the canister is rethrown — the
      // order @icp-sdk/auth uses.
      authState.authenticated = false;
      if (authState.signOutThrows) throw new Error("revoke failed");
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

const { resumeSession, sessionExpiresAt, signIn, signOut } = await import("../auth");
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
  authState.expired = false;
  authState.anonymous = anonymous;
  authState.principal = PRINCIPAL;
  authState.signOutCalls = 0;
  authState.signOutThrows = false;
  authState.getIdentityThrows = false;
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

  // Ending the sign-in also ends it at the II canister, which fails offline —
  // after this device is wiped. It must not abort the decision, or the lock
  // reason is lost and the user sees an unexplained sign-in screen.
  it("still decides, and purges, when ending the sign-in at the canister fails", async () => {
    await given({ markAgeMs: 60 * 60_000, authenticated: true }); // stale mark
    authState.signOutThrows = true;

    const { identity, lockReason } = await resumeSession();

    expect(identity).toBeNull();
    expect(lockReason).toBe("idle");
    expect(await keyStoreExists(PRINCIPAL)).toBe(false);
    expect(window.localStorage.getItem("vetvault:last-active")).toBeNull();
  });

  it("refuses a sign-in the record says has ended", async () => {
    await given({ markAgeMs: 60_000, authenticated: true });
    authState.expired = true;

    const { identity, lockReason } = await resumeSession();

    expect(identity).toBeNull();
    expect(lockReason).toBe("expired");
    expect(await keyStoreExists(PRINCIPAL)).toBe(false);
  });

  it("refuses rather than resuming when the sign-in cannot produce an identity", async () => {
    await given({ markAgeMs: 60_000, authenticated: true }); // mark is fresh
    authState.getIdentityThrows = true;

    const { identity, lockReason } = await resumeSession();

    // A delegation that cannot be read is not a delegation.
    expect(identity).toBeNull();
    expect(lockReason).toBe("expired");
    expect(await keyStoreExists(PRINCIPAL)).toBe(false);
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

describe("sessionExpiresAt", () => {
  // The identity's own delegation is short-lived and replaced as it ages, so
  // reading the deadline from it would lock the vault every few minutes.
  it("is the sign-in's end, from the sign-in record", async () => {
    await given({ markAgeMs: 0, authenticated: true });
    const expected = Date.now() + 3_600_000;

    expect(Math.abs((sessionExpiresAt() ?? 0) - expected)).toBeLessThan(1_000);
  });

  it("is null once the sign-in has ended", async () => {
    await given({ markAgeMs: 0, authenticated: true });
    authState.expired = true;

    expect(sessionExpiresAt()).toBeNull();
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

  it("still clears the mark when ending the sign-in throws", async () => {
    // The dangerous direction is failing halfway and leaving a mark that makes a
    // dead session look live.
    await given({ markAgeMs: 0, authenticated: true });
    authState.signOutThrows = true;

    await expect(signOut()).rejects.toThrow("revoke failed");

    expect(window.localStorage.getItem("vetvault:last-active")).toBeNull();
    expect(await keyStoreExists(PRINCIPAL)).toBe(false);
  });
});

describe("signIn", () => {
  // Internet Identity does not issue canister-scoped delegations, and asking for
  // one made sign-in fail outright — shipped once, and only surfaced in a manual
  // test. `@icp-sdk/auth` no longer takes `targets`; this keeps it from coming
  // back through an untyped call.
  it("does not request scoped targets", async () => {
    window.localStorage.clear();
    authState.anonymous = false;

    await signIn();

    expect(authState.signInOptions).toBeDefined();
    expect(authState.signInOptions?.targets).toBeUndefined();
  });

  it("requests the sign-in lifetime from SESSION_POLICY", async () => {
    const { SESSION_POLICY } = await import("../session");
    window.localStorage.clear();
    authState.anonymous = false;

    await signIn();

    expect(authState.signInOptions?.maxTimeToLive).toBe(
      BigInt(SESSION_POLICY.signInHours) * BigInt(3_600_000_000_000),
    );
  });

  it("marks the session live so the next load can resume it", async () => {
    window.localStorage.clear();
    authState.anonymous = false;

    await signIn();

    expect(window.localStorage.getItem("vetvault:principal")).toBe(PRINCIPAL);
  });
});
