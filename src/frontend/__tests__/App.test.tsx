import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ALICE, BOB, FakeClient, identityFor, item, vault } from "./harness";

/**
 * Tests for the layer every escaped defect has been in: not the logic, but how
 * `App` wires its pieces together. See #18.
 *
 * Everything is asserted through what is on screen. A test that reached into
 * component state would recreate exactly the blind spot it exists to close.
 */

const h = vi.hoisted(() => ({
  resumeSession: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("../lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/auth")>()),
  resumeSession: h.resumeSession,
  signIn: h.signIn,
  signOut: h.signOut,
  sessionExpiresAt: () => Date.now() + 8 * 60 * 60 * 1000,
}));

vi.mock("../lib/vault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/vault")>()),
  VaultClient: { create: h.createClient },
}));

// The real one installs timers and a BroadcastChannel; the lock path is already
// covered by lock.test.ts, and here it would only add noise.
vi.mock("../lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/session")>()),
  startSession: () => ({ stop: vi.fn(), broadcastLock: vi.fn(), remainingMs: () => 300_000 }),
}));

const { App, POLL_INTERVAL_MS } = await import("../App");

const SECRET = "correct-horse-battery";
const personal = vault({ itemIds: ["a"], fingerprint: "own-1" });
const shared = vault({
  owner: BOB,
  name: "Team infra",
  isOwned: false,
  itemIds: ["x"],
  fingerprint: "shared-1",
});

function signedInAs(principal = ALICE, client?: FakeClient) {
  const fake =
    client ??
    new FakeClient(principal, [personal], { Personal: [item({ id: "a", title: "GitHub", password: SECRET })] });
  h.resumeSession.mockResolvedValue({ identity: identityFor(principal), lockReason: null });
  h.createClient.mockResolvedValue(fake);
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.signOut.mockResolvedValue(undefined);
  h.resumeSession.mockResolvedValue({ identity: null, lockReason: null });
});

describe("locking", () => {
  it("leaves no decrypted secret on screen for the next principal", async () => {
    signedInAs(ALICE);
    render(<App />);
    await screen.findByText("GitHub");
    fireEvent.click(await screen.findByText("GitHub"));
    // Reveal it, so the plaintext really is in the DOM to begin with — masked,
    // the assertion below would pass without proving anything.
    fireEvent.click(await screen.findByRole("button", { name: /reveal password/i }));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /lock vault/i }));
    await screen.findByRole("button", { name: /unlock/i });

    // Signing in as someone else must not reveal the first principal's items.
    // This is the shape of the leak that reached review in #12: `App` stays
    // mounted through a lock, so anything not cleared is simply still there.
    const bobsClient = new FakeClient(BOB, [vault({ owner: BOB, itemIds: ["b"], fingerprint: "bob-1" })], {
      Personal: [item({ id: "b", title: "Bob's bank", password: "different" })],
    });
    h.signIn.mockResolvedValue(identityFor(BOB));
    h.createClient.mockResolvedValue(bobsClient);
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    await screen.findByText("Bob's bank");
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it("does not strand the sign-in button while a killed request is still in flight", async () => {
    const client = signedInAs(ALICE);
    // A save whose response never arrives, standing in for one that dies with
    // the delegation. `run`'s own `finally` cannot clear `busy` until it
    // settles, so only the lock can — and `busy` is not part of the grouped
    // session state, so clearing it has to be remembered separately.
    client.saveItem.mockImplementation(() => new Promise<void>(() => {}));
    render(<App />);
    fireEvent.click(await screen.findByText("GitHub"));
    fireEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /save/i }));

    fireEvent.click(screen.getByRole("button", { name: /lock vault/i }));

    const unlock = await screen.findByRole("button", { name: /unlock/i });
    expect(unlock).not.toBeDisabled();
  });
});

describe("a shared vault whose rights the canister will not disclose", () => {
  it("offers editing, then stops once the canister refuses", async () => {
    const client = signedInAs(ALICE, new FakeClient(ALICE, [personal, shared], {
      "Team infra": [item({ id: "x", title: "Grafana" })],
    }));
    render(<App />);

    fireEvent.click(await screen.findByText("Team infra"));
    fireEvent.click(await screen.findByText("Grafana"));

    // Offered, because "we were not told" is not "no" — #9.
    const edit = await screen.findByRole("button", { name: /^edit$/i });

    client.refuse = "write";
    fireEvent.click(edit);
    fireEvent.click(await screen.findByRole("button", { name: /save/i }));

    expect(await screen.findByText("You have read-only access to this vault.")).toBeInTheDocument();
    // And the control is withdrawn rather than left to fail again.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument(),
    );
  });
});

describe("an error banner", () => {
  it("does not follow the user to another vault", async () => {
    const client = signedInAs(ALICE, new FakeClient(ALICE, [personal, shared], {}));
    client.refuse = "open";
    render(<App />);

    // "this vault" binds the sentence to whatever is selected, so carrying it
    // across a switch makes it a false statement about the new one.
    const banner = await screen.findByText("You no longer have access to this vault.");
    expect(banner).toBeInTheDocument();

    client.refuse = "none";
    fireEvent.click(screen.getByText("Team infra"));

    await waitFor(() =>
      expect(screen.queryByText("You no longer have access to this vault.")).not.toBeInTheDocument(),
    );
  });
});

describe("landing", () => {
  it("opens your own vault, not whichever the canister listed first", async () => {
    // The canister chains shared maps before owned ones, so the old
    // `vaults[0]` fallback landed people on someone else's vault — #16.
    signedInAs(ALICE, new FakeClient(ALICE, [shared, personal], {
      Personal: [item({ id: "a", title: "GitHub" })],
      "Team infra": [item({ id: "x", title: "Grafana" })],
    }));
    render(<App />);

    expect(await screen.findByText("GitHub")).toBeInTheDocument();
    expect(screen.queryByText("Grafana")).not.toBeInTheDocument();
  });

  it("shows an item added while nothing was explicitly selected", async () => {
    // The reported bug: with no click, the poll reconciled against "nothing
    // selected" and the new item never appeared.
    //
    // This reaches the fix through `connect` seeding the selection — verified
    // by mutation, removing that seeding fails every test here. `reconcile`'s
    // own null-resolution is the second half, belt-and-braces, and is
    // deliberately unreachable from this level once the first half works; it is
    // covered directly in reconcile.test.ts instead.
    const empty = vault({ itemIds: [], fingerprint: "own-0" });
    const client = signedInAs(ALICE, new FakeClient(ALICE, [empty], { Personal: [] }));
    render(<App />);
    await screen.findByText(/this vault is empty/i);

    client.vaults = [vault({ itemIds: ["a"], fingerprint: "own-1" })];
    client.items.set("Personal", [item({ id: "a", title: "GitHub" })]);
    fireEvent.click(screen.getByRole("button", { name: /check for changes/i }));

    expect(await screen.findByText("GitHub")).toBeInTheDocument();
  });

  it("moves the user off a vault revoked under them, and says so", async () => {
    const client = signedInAs(ALICE, new FakeClient(ALICE, [personal, shared], {
      Personal: [item({ id: "a", title: "GitHub" })],
      "Team infra": [item({ id: "x", title: "Grafana" })],
    }));
    render(<App />);
    fireEvent.click(await screen.findByText("Team infra"));
    await screen.findByText("Grafana");

    client.vaults = [personal];
    fireEvent.click(screen.getByRole("button", { name: /check for changes/i }));

    expect(await screen.findByText("“Team infra” is no longer shared with you.")).toBeInTheDocument();
    expect(await screen.findByText("GitHub")).toBeInTheDocument();
  });
});

/**
 * The 15 s poll is a README-advertised feature, and it fails silently: updates
 * simply stop appearing, which looks exactly like #16. Every other test here
 * drives `refresh` through the manual button, so the interval, the listener and
 * the visibility guard would each have had nothing behind them.
 */
describe("polling for changes", () => {
  it("re-reads the vault list on its own, with no interaction", async () => {
    // Fake timers must be installed before render: the interval is scheduled
    // during the effect, and one created with the real timer is not advanced by
    // a fake clock swapped in afterwards.
    vi.useFakeTimers();
    try {
      const client = signedInAs(ALICE);
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      const before = client.listVaults.mock.calls.length;

      await act(() => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS));

      expect(client.listVaults.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("catches up as soon as the tab is visible again, without waiting a tick", async () => {
    const client = signedInAs(ALICE, new FakeClient(ALICE, [vault({ itemIds: [], fingerprint: "own-0" })], {
      Personal: [],
    }));
    render(<App />);
    await screen.findByText(/this vault is empty/i);

    client.vaults = [vault({ itemIds: ["a"], fingerprint: "own-1" })];
    client.items.set("Personal", [item({ id: "a", title: "GitHub" })]);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(await screen.findByText("GitHub")).toBeInTheDocument();
  });

  it("does not poll a hidden tab", async () => {
    const client = signedInAs(ALICE);
    render(<App />);
    await screen.findByText("GitHub");

    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      const before = client.listVaults.mock.calls.length;
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // A background tab should cost nothing — the guard, not the timer, is
      // what makes the poll affordable to leave running.
      expect(client.listVaults.mock.calls.length).toBe(before);
    } finally {
      hidden.mockRestore();
    }
  });
});
