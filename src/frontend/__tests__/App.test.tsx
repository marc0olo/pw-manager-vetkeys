import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ALICE, BOB, FakeClient, fakeClipboard, identityFor, item, trashed, vault, version } from "./harness";
import { toAccessRights, type AccessLevel } from "../lib/vault";

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

describe("renaming a vault", () => {
  const renamed = () =>
    new FakeClient(ALICE, [vault({ itemIds: ["a"], fingerprint: "own-1", displayName: "Home" })], {
      Personal: [item({ id: "a", title: "GitHub" })],
    });

  it("shows the chosen name everywhere, never the map name", async () => {
    signedInAs(ALICE, renamed());
    render(<App />);

    // The map name is identity and the key-derivation input; showing it would
    // defeat the point of renaming.
    expect(await screen.findAllByText("Home")).not.toHaveLength(0);
    expect(screen.queryByText("Personal")).not.toBeInTheDocument();
  });

  it("is offered for a vault you own", async () => {
    signedInAs(ALICE);
    render(<App />);
    expect(await screen.findByRole("button", { name: /rename/i })).toBeInTheDocument();
  });

  it("is not offered for a vault shared with you", async () => {
    // Owner-only by construction on the canister; the UI should not imply
    // otherwise and then fail.
    signedInAs(ALICE, new FakeClient(ALICE, [personal, shared], {
      "Team infra": [item({ id: "x", title: "Grafana" })],
    }));
    render(<App />);
    fireEvent.click(await screen.findByText("Team infra"));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /rename/i })).not.toBeInTheDocument(),
    );
  });

  it("says the original name cannot be changed", async () => {
    // Without this a rename implies a privacy property it does not have:
    // "Divorce lawyer" renamed to "Misc" is still Divorce lawyer in the listing.
    signedInAs(ALICE, renamed());
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /rename/i }));

    expect(await screen.findByText(/original name cannot be changed/i)).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
  });

  it("saves the new name and closes", async () => {
    const client = signedInAs(ALICE);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /rename/i }));

    const field = await screen.findByDisplayValue("Personal");
    fireEvent.change(field, { target: { value: "Home" } });
    client.vaults = [vault({ itemIds: ["a"], fingerprint: "own-1", displayName: "Home" })];
    // Both the toolbar control and the dialog's submit are called "Rename".
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^rename$/i }));

    await waitFor(() => expect(client.rename).toHaveBeenCalled());
    expect(await screen.findAllByText("Home")).not.toHaveLength(0);
  });
});

describe("trash in a shared vault", () => {
  // Trash belongs to the vault, so read access is enough to look — and the
  // canister agrees, since `restore_trashed_values` restores every entry in
  // the vault on write access alone. The rule the UI has to get right is that
  // seeing and recovering are separate.
  const withTrash = (level: AccessLevel) =>
    signedInAs(
      ALICE,
      Object.assign(
        new FakeClient(
          ALICE,
          [personal, vault({ owner: BOB, name: "Team infra", isOwned: false, rights: toAccessRights(level), itemIds: ["x"], fingerprint: "s", trashed: 2 })],
          { "Team infra": [item({ id: "x", title: "Grafana" })] },
        ),
        {
          trash: [
            trashed({ seq: 41n, item: item({ id: "gone", title: "Old root password" }) }),
            trashed({ seq: 42n, item: item({ id: "gone2", title: "Retired API key" }), deletedBy: BOB }),
          ],
        },
      ),
    );

  it("lets a read-only member see what was deleted", async () => {
    withTrash("Read");
    render(<App />);
    fireEvent.click(await screen.findByText("Team infra"));

    fireEvent.click(await screen.findByRole("button", { name: /2 deleted/i }));

    // The titles, not just timestamps — the whole reason the listing carries
    // ciphertext.
    expect(await screen.findByText("Old root password")).toBeInTheDocument();
    expect(screen.getByText("Retired API key")).toBeInTheDocument();
  });

  it("but does not offer to restore it", async () => {
    const client = withTrash("Read");
    render(<App />);
    fireEvent.click(await screen.findByText("Team infra"));
    fireEvent.click(await screen.findByRole("button", { name: /2 deleted/i }));
    await screen.findByText("Old root password");

    expect(screen.queryByRole("button", { name: /^restore$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restore all/i })).not.toBeInTheDocument();
    // And says why, rather than showing a list with no explanation for the
    // missing buttons.
    expect(screen.getByText(/read-only access/i)).toBeInTheDocument();
    expect(client.restoreVersion).not.toHaveBeenCalled();
  });

  it("offers recovery to a member who can write", async () => {
    const client = withTrash("ReadWrite");
    render(<App />);
    fireEvent.click(await screen.findByText("Team infra"));
    fireEvent.click(await screen.findByRole("button", { name: /2 deleted/i }));

    fireEvent.click((await screen.findAllByRole("button", { name: /^restore$/i }))[0]);

    // The event, not the item id — a secret deleted, restored and deleted again
    // has several rows, so restoring by item id would pick an arbitrary one.
    await waitFor(() => expect(client.restoreVersion).toHaveBeenCalledWith(expect.anything(), 41n));
  });
});

describe("sharing a vault that has trash", () => {
  const owned = (count: number) =>
    Object.assign(
      new FakeClient(ALICE, [vault({ itemIds: ["a"], trashed: count })], {
        Personal: [item({ id: "a", title: "GitHub" })],
      }),
      { trash: Array.from({ length: count }, (_, i) => trashed({ item: item({ id: `d${i}`, title: `Deleted ${i}` }) })) },
    );

  it("says what the grantee will be able to see", async () => {
    signedInAs(ALICE, owned(3));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /share/i }));

    expect(await screen.findByRole("note")).toHaveTextContent(/trash holds 3 deleted items/i);
  });

  it("stays quiet when there is nothing in the trash", async () => {
    signedInAs(ALICE, owned(0));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /share/i }));
    await screen.findByRole("dialog");

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("does not offer to empty the trash from here — that lives in the trash view", async () => {
    // Duplicating a destructive action across two screens is how the two drift
    // apart, so this dialog states the consequence and nothing more.
    signedInAs(ALICE, owned(3));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /share/i }));
    await screen.findByRole("note");

    expect(screen.queryByRole("button", { name: /empty trash/i })).not.toBeInTheDocument();
  });
});

describe("emptying the trash", () => {
  const owning = (count: number) =>
    Object.assign(
      new FakeClient(ALICE, [vault({ itemIds: ["a"], trashed: count })], {
        Personal: [item({ id: "a", title: "GitHub" })],
      }),
      {
        trash: Array.from({ length: count }, (_, i) =>
          trashed({ item: item({ id: `d${i}`, title: `Deleted ${i}` }) }),
        ),
      },
    );

  const openTrash = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /3 deleted/i }));
    return screen.findByText("Deleted 0");
  };

  it("asks before destroying anything", async () => {
    const client = owning(3);
    signedInAs(ALICE, client);
    render(<App />);
    await openTrash();

    fireEvent.click(screen.getByRole("button", { name: /^empty trash$/i }));

    expect(client.discardTrash).not.toHaveBeenCalled();
    expect(screen.getByText(/for good\?/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /delete permanently/i }));
    await waitFor(() => expect(client.discardTrash).toHaveBeenCalledTimes(1));
  });

  it("keeps everything when the confirmation is declined", async () => {
    const client = owning(3);
    signedInAs(ALICE, client);
    render(<App />);
    await openTrash();
    fireEvent.click(screen.getByRole("button", { name: /^empty trash$/i }));

    fireEvent.click(screen.getByRole("button", { name: /keep them/i }));

    expect(client.discardTrash).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^empty trash$/i })).toBeInTheDocument();
  });

  it("is not offered to a member who cannot restore", async () => {
    // Emptying is destructive where restoring is not, so read access must not
    // reach it. The canister refuses it too — this only stops the UI offering
    // a button that would come back "unauthorized".
    signedInAs(
      ALICE,
      Object.assign(
        new FakeClient(
          ALICE,
          [
            vault({
              owner: BOB,
              name: "Team infra",
              isOwned: false,
              rights: toAccessRights("Read"),
              itemIds: ["x"],
              trashed: 3,
              fingerprint: "s",
            }),
          ],
          { "Team infra": [item({ id: "x", title: "Grafana" })] },
        ),
        { trash: [trashed({ item: item({ id: "d0", title: "Deleted 0" }) })] },
      ),
    );
    render(<App />);
    // The only vault, so it is already selected.
    await openTrash();

    expect(screen.queryByRole("button", { name: /^empty trash$/i })).not.toBeInTheDocument();
  });
});

describe("deleting one item", () => {
  it("confirms in the app's own dialog rather than the browser's", async () => {
    const client = signedInAs(ALICE);
    // A native confirm() blocks the event loop, which in this app also defers
    // the interval that locks the vault — so the prompt can hold plaintext on
    // screen past the idle deadline. It is also unstylable and unassertable.
    const native = vi.spyOn(window, "confirm");
    render(<App />);
    fireEvent.click(await screen.findByText("GitHub"));

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(native).not.toHaveBeenCalled();
    // Named for the item, which is the thing a native prompt cannot style.
    expect(await screen.findByRole("dialog", { name: /delete github/i })).toBeInTheDocument();
    expect(client.deleteItem).not.toHaveBeenCalled();
    native.mockRestore();
  });

  it("says the deletion is recoverable, because it is", async () => {
    signedInAs(ALICE);
    render(<App />);
    fireEvent.click(await screen.findByText("GitHub"));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByText(/restored for 90 days/i)).toBeInTheDocument();
    expect(screen.queryByText(/permanent/i)).not.toBeInTheDocument();
  });

  it("deletes on confirmation, and not on cancel", async () => {
    const client = signedInAs(ALICE);
    render(<App />);
    fireEvent.click(await screen.findByText("GitHub"));

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    expect(client.deleteItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    const dialog = await screen.findByRole("dialog", { name: /delete github/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(client.deleteItem).toHaveBeenCalledTimes(1));
  });
});

// Fake timers before render: the interval is scheduled during the effect, and
// one created with the real timer is not advanced by a fake clock swapped in
// afterwards.
const onFakeTimers = async (body: () => Promise<void>) => {
  vi.useFakeTimers();
  try {
    await body();
  } finally {
    vi.useRealTimers();
  }
};

describe("someone else changes the trash while the dialog is open", () => {
  // The count alone cannot drive this: restore one item and delete another and
  // it is unchanged while the contents differ. The summary carries a
  // fingerprint so the poll can tell, without ciphertext riding the poll (#14).
  const clientWith = (fingerprint: string, title: string) =>
    Object.assign(
      new FakeClient(ALICE, [vault({ itemIds: ["a"], trashed: 1, trashFingerprint: fingerprint })], {
        Personal: [item({ id: "a", title: "GitHub" })],
      }),
      { trash: [trashed({ item: item({ id: "d0", title }) })] },
    );

  const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
  const poll = () => act(() => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS));

  it("re-reads the list when the fingerprint moves", async () =>
    onFakeTimers(async () => {
      const client = clientWith("t-before", "Old password");
      signedInAs(ALICE, client);
      render(<App />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: /1 deleted/i }));
      await settle();
      expect(screen.getByText("Old password")).toBeInTheDocument();

      // A different person deleted something else. Same count, new contents.
      client.vaults = [vault({ itemIds: ["a"], trashed: 1, trashFingerprint: "t-after" })];
      client.trash = [trashed({ item: item({ id: "d1", title: "Someone else's deletion" }) })];
      await poll();

      expect(screen.getByText("Someone else's deletion")).toBeInTheDocument();
      expect(screen.queryByText("Old password")).not.toBeInTheDocument();
    }));

  it("does not re-read when nothing changed", async () =>
    onFakeTimers(async () => {
      const client = clientWith("t-same", "Old password");
      signedInAs(ALICE, client);
      render(<App />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: /1 deleted/i }));
      await settle();
      const before = client.listTrash.mock.calls.length;

      await poll();

      // Ciphertext must not be fetched on a timer just because a dialog is open.
      expect(client.listTrash.mock.calls.length).toBe(before);
    }));

  it("does not fetch the trash at all while the dialog is closed", async () =>
    onFakeTimers(async () => {
      const client = clientWith("t-before", "Old password");
      signedInAs(ALICE, client);
      render(<App />);
      await settle();

      client.vaults = [vault({ itemIds: ["a"], trashed: 1, trashFingerprint: "t-after" })];
      await poll();

      expect(client.listTrash).not.toHaveBeenCalled();
    }));
});

describe("emptying the trash is the owner's, not a writer's", () => {
  // Reported from manual testing as a `ReadWrite` grantee: Empty trash was
  // offered, the canister refused it, and the "+" button then went dead — the
  // ownership refusal had been filed as a *write* denial. A reload cleared it,
  // because denials are session-scoped.
  const sharedWithWrite = (trash: ReturnType<typeof trashed>[]) =>
    Object.assign(
      new FakeClient(
        ALICE,
        [
          vault({
            owner: BOB,
            name: "Team infra",
            isOwned: false,
            rights: toAccessRights("ReadWrite"),
            itemIds: ["x"],
            trashed: trash.length,
            fingerprint: "s",
          }),
        ],
        { "Team infra": [item({ id: "x", title: "Grafana" })] },
      ),
      { trash },
    );

  const openTrash = async (client: FakeClient) => {
    signedInAs(ALICE, client);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /1 deleted/i }));
    return screen.findByText("Owner's deletion");
  };

  it("is not offered to a writer who does not own the vault", async () => {
    const client = sharedWithWrite([trashed({ item: item({ id: "d0", title: "Owner's deletion" }), deletedBy: BOB })]);
    await openTrash(client);

    // Restoring is a writer's; making it unrecoverable is not.
    expect(screen.getByRole("button", { name: /^restore$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^empty trash$/i })).not.toBeInTheDocument();
  });

  it("does not disable writing when the canister refuses it", async () => {
    // Driven through the owner, because after the gate above a non-owner can no
    // longer reach the button — and the point of this test is the *refusal*
    // path, not the gate. A refusal can still arrive: ownership is read from a
    // poll that may be a few seconds old.
    const client = Object.assign(
      new FakeClient(ALICE, [vault({ itemIds: ["a"], trashed: 1 })], {
        Personal: [item({ id: "a", title: "GitHub" })],
      }),
      { trash: [trashed({ item: item({ id: "d0", title: "Owner's deletion" }) })], refuseDiscard: true },
    );
    signedInAs(ALICE, client);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /1 deleted/i }));
    await screen.findByText("Owner's deletion");

    fireEvent.click(screen.getByRole("button", { name: /^empty trash$/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete permanently/i }));

    expect(await screen.findByText(/only the vault's owner/i)).toBeInTheDocument();
    // The cascade. Ownership is not a capability, so refusing it must not be
    // remembered against write — that is what killed the "+" button.
    expect(screen.getByRole("button", { name: /new item/i })).not.toBeDisabled();
    // And the dialog stays usable: restoring was never what was refused.
    expect(screen.getByRole("button", { name: /^restore$/i })).toBeInTheDocument();
  });
});

describe("a secret's version history", () => {
  const withVersions = (versions: ReturnType<typeof version>[], owned = true) =>
    Object.assign(
      new FakeClient(
        ALICE,
        [
          owned
            ? vault({ itemIds: ["a"] })
            : vault({ owner: BOB, name: "Team infra", isOwned: false, rights: toAccessRights("ReadWrite"), itemIds: ["a"], fingerprint: "s" }),
        ],
        { [owned ? "Personal" : "Team infra"]: [item({ id: "a", title: "GitHub", password: "current" })] },
      ),
      { itemVersions: { a: versions } },
    );

  const openItem = async (client: FakeClient) => {
    signedInAs(ALICE, client);
    render(<App />);
    fireEvent.click(await screen.findByText("GitHub"));
    return screen.findByRole("button", { name: /^edit$/i });
  };

  it("says how many versions there are without fetching them", async () => {
    const client = withVersions([
      version({ item: item({ id: "a", title: "GitHub", password: "older" }) }),
      version({ item: item({ id: "a", title: "GitHub", password: "oldest" }) }),
    ]);
    await openItem(client);

    expect(await screen.findByRole("button", { name: /2 earlier versions/i })).toBeInTheDocument();
    // The count comes with the vault; the ciphertext does not.
    expect(client.versions).not.toHaveBeenCalled();
  });

  it("fetches and shows them when expanded", async () => {
    const client = withVersions([version({ item: item({ id: "a", title: "Old GitHub name" }) })]);
    await openItem(client);

    fireEvent.click(screen.getByRole("button", { name: /1 earlier version/i }));

    expect(await screen.findByText("Old GitHub name")).toBeInTheDocument();
    expect(client.versions).toHaveBeenCalledTimes(1);
  });

  it("says nothing at all when a secret has never been changed", async () => {
    const client = withVersions([]);
    await openItem(client);

    expect(screen.queryByRole("button", { name: /earlier version/i })).not.toBeInTheDocument();
  });

  it("restores a version by its event", async () => {
    const client = withVersions([version({ seq: 77n, item: item({ id: "a", title: "Old GitHub name" }) })]);
    await openItem(client);
    fireEvent.click(screen.getByRole("button", { name: /1 earlier version/i }));
    await screen.findByText("Old GitHub name");

    fireEvent.click(screen.getByRole("button", { name: /^restore$/i }));

    await waitFor(() => expect(client.restoreVersion).toHaveBeenCalledWith(expect.anything(), 77n));
  });

  it("shows the canister's timestamp, not the one inside the item", async () => {
    // `updatedAt` lives in the plaintext and is written by whoever last saved
    // the item, so it is the writer's to choose — the same shape of problem as
    // `deleted_by` before the event log.
    const client = withVersions([version({ item: item({ id: "a", title: "GitHub" }) })]);
    client.items.set("Personal", [
      item({ id: "a", title: "GitHub", updatedAt: Date.UTC(2001, 0, 1, 12, 0) }),
    ]);
    await openItem(client);

    const stamp = screen.getByText(/^Updated /);
    expect(stamp).toHaveTextContent("2026");
    expect(stamp).not.toHaveTextContent("2001");
  });

  it("offers pruning to the owner only, and asks first", async () => {
    const client = withVersions([version({ item: item({ id: "a", title: "Old" }) })]);
    await openItem(client);
    fireEvent.click(screen.getByRole("button", { name: /1 earlier version/i }));
    await screen.findByText("Old");

    fireEvent.click(screen.getByRole("button", { name: /delete stored versions/i }));
    expect(client.dropHistory).not.toHaveBeenCalled();
    // The record survives pruning, and saying so is the point of the copy.
    expect(screen.getByText(/record of who changed this and when is kept/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /delete versions/i }));
    await waitFor(() => expect(client.dropHistory).toHaveBeenCalledTimes(1));
  });

  it("does not offer pruning to a writer who does not own the vault", async () => {
    const client = withVersions([version({ item: item({ id: "a", title: "Old" }) })], false);
    signedInAs(ALICE, client);
    render(<App />);
    fireEvent.click(await screen.findByText("GitHub"));
    fireEvent.click(await screen.findByRole("button", { name: /1 earlier version/i }));
    await screen.findByText("Old");

    // Restoring is a writer's; making versions unrecoverable is the owner's.
    expect(screen.getByRole("button", { name: /^restore$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete stored versions/i })).not.toBeInTheDocument();
  });

  it("does not show one item's versions under another", async () => {
    const client = withVersions([version({ item: item({ id: "a", title: "Secret old name" }) })]);
    client.items.set("Personal", [
      item({ id: "a", title: "GitHub" }),
      item({ id: "b", title: "Bank" }),
    ]);
    client.vaults = [vault({ itemIds: ["a", "b"] })];
    signedInAs(ALICE, client);
    render(<App />);
    fireEvent.click(await screen.findByText("GitHub"));
    fireEvent.click(await screen.findByRole("button", { name: /1 earlier version/i }));
    expect(await screen.findByText("Secret old name")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Bank"));

    // The list is keyed to the item it was read for, so switching cannot show
    // it under a different secret. `history` is also cleared, but that is
    // hygiene rather than a guarantee: `openItems` already holds every item in
    // the vault decrypted, so nothing here is the last line of defence — the
    // lock clearing the whole session is.
    expect(screen.queryByText("Secret old name")).not.toBeInTheDocument();
  });
});

describe("a version's password", () => {
  const openHistory = async (versions: ReturnType<typeof version>[]) => {
    const client = Object.assign(
      new FakeClient(ALICE, [vault({ itemIds: ["a"] })], {
        Personal: [item({ id: "a", title: "GitHub", password: "current-pw" })],
      }),
      { itemVersions: { a: versions } },
    );
    signedInAs(ALICE, client);
    render(<App />);
    fireEvent.click(await screen.findByText("GitHub"));
    fireEvent.click(await screen.findByRole("button", { name: /earlier version/i }));
    await screen.findAllByRole("button", { name: /reveal this version's password/i });
    return client;
  };

  it("is masked until asked for", async () => {
    await openHistory([version({ item: item({ id: "a", title: "GitHub", password: "old-secret" }) })]);

    expect(screen.queryByText("old-secret")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /reveal this version's password/i }));

    expect(screen.getByText("old-secret")).toBeInTheDocument();
  });

  it("hides again on its own, so it does not sit on screen", async () => {
    vi.useFakeTimers();
    try {
      const client = Object.assign(
        new FakeClient(ALICE, [vault({ itemIds: ["a"] })], {
          Personal: [item({ id: "a", title: "GitHub", password: "current-pw" })],
        }),
        { itemVersions: { a: [version({ item: item({ id: "a", title: "GitHub", password: "old-secret" }) })] } },
      );
      signedInAs(ALICE, client);
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByText("GitHub"));
      fireEvent.click(screen.getByRole("button", { name: /earlier version/i }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(screen.getByRole("button", { name: /reveal this version's password/i }));
      expect(screen.getByText("old-secret")).toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(30_000));

      expect(screen.queryByText("old-secret")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows one at a time, so a list of passwords never accumulates", async () => {
    await openHistory([
      version({ seq: 90n, item: item({ id: "a", title: "GitHub", password: "newer-old" }) }),
      version({ seq: 91n, item: item({ id: "a", title: "GitHub", password: "older-old" }) }),
    ]);
    const [first, second] = screen.getAllByRole("button", { name: /reveal this version's password/i });

    fireEvent.click(first);
    expect(screen.getByText("newer-old")).toBeInTheDocument();

    fireEvent.click(second);

    expect(screen.getByText("older-old")).toBeInTheDocument();
    expect(screen.queryByText("newer-old")).not.toBeInTheDocument();
  });

  it("stops showing when the list is collapsed", async () => {
    await openHistory([version({ item: item({ id: "a", title: "GitHub", password: "old-secret" }) })]);
    fireEvent.click(screen.getByRole("button", { name: /reveal this version's password/i }));
    expect(screen.getByText("old-secret")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /earlier version/i }));
    fireEvent.click(screen.getByRole("button", { name: /earlier version/i }));

    // Wait for the list to come back before asserting: expanding re-reads it,
    // so asserting straight away would find nothing on screen either way and
    // pass without proving the reveal was reset.
    await screen.findByRole("button", { name: /reveal this version's password/i });
    expect(screen.queryByText("old-secret")).not.toBeInTheDocument();
  });

  it("copies through the same path as the live one, so the clipboard still clears", async () => {
    const board = fakeClipboard();
    await openHistory([version({ item: item({ id: "a", title: "GitHub", password: "old-secret" }) })]);

    fireEvent.click(screen.getByRole("button", { name: /copy this version's password/i }));

    // The message is the tell that it went through `copySecret` rather than
    // `copyPlain`: only the secret path schedules the clipboard to be cleared.
    expect(await screen.findByText(/clipboard clears in/i)).toBeInTheDocument();
    expect(board.text).toBe("old-secret");
  });
});

describe("with no vaults at all", () => {
  // A real state now: the client used to synthesise a `Personal` vault whenever
  // it saw none, which is what made "zero vaults" unreachable and hid the fact
  // that the app had nowhere to start.
  const empty = () => new FakeClient(ALICE, [], {});

  it("says so, instead of loading forever", async () => {
    signedInAs(ALICE, empty());
    render(<App />);

    expect(await screen.findByText(/no vaults yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/deriving your vault key/i)).not.toBeInTheDocument();
  });

  it("offers to create one, and lands on it", async () => {
    const client = empty();
    signedInAs(ALICE, client);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /create a vault/i }));

    const field = await screen.findByLabelText(/name/i);
    fireEvent.change(field, { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("button", { name: /create vault/i }));

    await waitFor(() => expect(client.createVault).toHaveBeenCalledWith("Work"));
    // The label the user typed, not the map name — in the sidebar and as the
    // pane title, which is why this counts rather than expecting one.
    expect((await screen.findAllByText("Work")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no vaults yet/i)).not.toBeInTheDocument();
  });

  it("passes the label through, and nothing else", async () => {
    // Only the wiring. Whether the *map* name is opaque is a property of
    // `VaultClient.createVault`, which this suite mocks — so asserting it here
    // would be asserting the fake. It is pinned in vaultname.test.ts instead.
    const client = empty();
    signedInAs(ALICE, client);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /create a vault/i }));
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: "  Divorce lawyer  " } });
    fireEvent.click(screen.getByRole("button", { name: /create vault/i }));

    await waitFor(() => expect(client.createVault).toHaveBeenCalledWith("Divorce lawyer"));
  });

  it("can be dismissed, back to the screen that has the principal", async () => {
    // It used to have no Cancel, on the reasoning that a user with no vaults
    // had nothing behind the dialog. That stopped being true once the screen
    // carried their principal — someone who opens this and then decides they
    // would rather be shared with has to be able to get back to it.
    signedInAs(ALICE, empty());
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /create a vault/i }));

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(await screen.findByText(/no vaults yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy my principal/i })).toBeInTheDocument();
  });
});

describe("creating another vault", () => {
  it("is offered in the sidebar", async () => {
    const client = signedInAs(ALICE);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new vault/i }));

    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: "Second" } });
    fireEvent.click(screen.getByRole("button", { name: /create vault/i }));

    await waitFor(() => expect(client.createVault).toHaveBeenCalledWith("Second"));
  });

  it("warns that the label is stored unencrypted", async () => {
    signedInAs(ALICE);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new vault/i }));

    expect(await screen.findByText(/stored unencrypted/i)).toBeInTheDocument();
  });
});

describe("deleting a vault", () => {
  it("needs the name typed, and says the key is not destroyed", async () => {
    const client = signedInAs(ALICE);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /delete vault/i }));
    // Scoped: the trigger and the confirmation share a label, and that is
    // deliberate — the button you press twice should say the same thing.
    const dialog = await screen.findByRole("dialog", { name: /delete personal/i });

    // The honest caveat: the key derives from (owner, name), so deleting data
    // is not the same as destroying the key.
    expect(within(dialog).getByText(/not the same as destroying the key/i)).toBeInTheDocument();

    const confirm = within(dialog).getByRole("button", { name: /^delete vault$/i });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(/to confirm/i), { target: { value: "Personal" } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(client.deleteVault).toHaveBeenCalledTimes(1));
  });

  it("is not offered on a vault shared with you", async () => {
    signedInAs(
      ALICE,
      new FakeClient(ALICE, [vault({ owner: BOB, name: "Team infra", isOwned: false, rights: toAccessRights("ReadWriteManage"), itemIds: ["x"], fingerprint: "s" })], {
        "Team infra": [item({ id: "x", title: "Grafana" })],
      }),
    );
    render(<App />);
    await screen.findByText("Grafana");

    // Revoking needs manage rights, which a grantee can have — but the vault is
    // not theirs to remove, so Empty is as far as it goes.
    expect(screen.queryByRole("button", { name: /delete vault/i })).not.toBeInTheDocument();
  });

  it("falls back to the zero-vault state when it was the last one", async () => {
    const client = signedInAs(ALICE);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /delete vault/i }));
    const dialog = await screen.findByRole("dialog", { name: /delete personal/i });
    fireEvent.change(within(dialog).getByLabelText(/to confirm/i), { target: { value: "Personal" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete vault$/i }));

    await waitFor(() => expect(client.deleteVault).toHaveBeenCalled());
    expect(await screen.findByText(/no vaults yet/i)).toBeInTheDocument();
  });
});

describe("two vaults may not show the same name", () => {
  // The typed delete confirmation arms on the label, so duplicates make it
  // confirm a name rather than a vault — and delete is irreversible.
  const twoVaults = () =>
    new FakeClient(
      ALICE,
      [vault({ name: "aaa", displayName: "Work", itemIds: ["a"] }), vault({ name: "bbb", displayName: "Home" })],
      { aaa: [item({ id: "a", title: "GitHub" })] },
    );

  it("refuses a duplicate before submitting", async () => {
    const client = twoVaults();
    signedInAs(ALICE, client);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new vault/i }));
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: "Home" } });

    expect(screen.getByRole("button", { name: /create vault/i })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/already have a vault called/i);
    expect(client.createVault).not.toHaveBeenCalled();
  });

  it("allows one that is merely similar", async () => {
    signedInAs(ALICE, twoVaults());
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new vault/i }));
    fireEvent.change(await screen.findByLabelText(/name/i), { target: { value: "home" } });

    // Case-sensitive on purpose: refusing a name for a difference the user
    // cannot see is its own problem.
    expect(screen.getByRole("button", { name: /create vault/i })).not.toBeDisabled();
  });

  it("does not refuse renaming a vault to what it is already called", async () => {
    signedInAs(ALICE, twoVaults());
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /rename/i }));
    // Scoped: the sidebar's vault rows also match /name/i.
    const dialog = await screen.findByRole("dialog", { name: /rename/i });

    const field = within(dialog).getByRole("textbox");
    fireEvent.change(field, { target: { value: "Home" } });
    // Another vault holds it.
    expect(within(dialog).getByRole("button", { name: /^rename$/i })).toBeDisabled();

    fireEvent.change(field, { target: { value: "Work" } });
    // Its own name — unchanged, so nothing to submit, but not reported as taken.
    expect(screen.queryByText(/already have a vault called/i)).not.toBeInTheDocument();
  });
});

describe("with no vaults, but wanting one shared with you", () => {
  // The dead end #47 created: the principal lives in the sidebar, which renders
  // after this screen's early return — so the one thing needed to leave the
  // state was the one thing the state hid.
  const none = () => new FakeClient(ALICE, [], {});

  it("shows the principal, so someone can share with you", async () => {
    signedInAs(ALICE, none());
    render(<App />);
    await screen.findByText(/no vaults yet/i);

    expect(screen.getByText(ALICE.toText())).toBeInTheDocument();
  });

  it("copies it without needing a vault first", async () => {
    const board = fakeClipboard();
    signedInAs(ALICE, none());
    render(<App />);
    await screen.findByText(/no vaults yet/i);

    fireEvent.click(screen.getByRole("button", { name: /copy my principal/i }));

    await waitFor(() => expect(board.text).toBe(ALICE.toText()));
    // And says so. The toast used to be rendered only by the main view, which
    // is past this screen's early return — so the one screen whose whole
    // purpose is copying a principal could not confirm that it had.
    expect(await screen.findByRole("status")).toHaveTextContent(/principal is on the clipboard/i);
  });

  it("says so when the browser blocks the clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    signedInAs(ALICE, none());
    render(<App />);
    await screen.findByText(/no vaults yet/i);

    fireEvent.click(screen.getByRole("button", { name: /copy my principal/i }));

    // The error banner was past the early return too, so a blocked clipboard
    // was as silent as a successful copy.
    expect(await screen.findByRole("alert")).toHaveTextContent(/blocked clipboard access/i);
  });

  it("does not imply creating one is the only way forward", async () => {
    signedInAs(ALICE, none());
    render(<App />);

    // The screen used to assert a premise that is not true — that having no
    // vaults means wanting to create one.
    expect(await screen.findByText(/or share your principal/i)).toBeInTheDocument();
  });

  it("picks up a vault shared while sitting here, with no reload", async () =>
    onFakeTimers(async () => {
      const client = none();
      signedInAs(ALICE, client);
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText(/no vaults yet/i)).toBeInTheDocument();

      // Someone grants access. The poll is registered before this screen's
      // early return, so nothing else has to happen.
      client.vaults = [
        vault({ owner: BOB, name: "Team infra", isOwned: false, rights: toAccessRights("Read"), itemIds: ["x"], fingerprint: "s" }),
      ];
      client.items.set("Team infra", [item({ id: "x", title: "Grafana" })]);
      await act(() => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS));

      // Queried synchronously: `findBy*` polls on timers, which a fake clock
      // does not advance on its own, so awaiting one here hangs the test.
      expect(screen.queryByText(/no vaults yet/i)).not.toBeInTheDocument();
      // Sidebar row and pane title, which is the point — it is not merely in
      // the list, it is selected and open.
      expect(screen.getAllByText("Team infra").length).toBeGreaterThan(1);
    }));
});

describe("when every vault you can see belongs to someone else", () => {
  // Reachable for the first time: before #47 the client synthesised an owned
  // vault, so there was always one. `defaultVaultId` prefers an owned vault and
  // falls back to the first listed, which is now a shared one.
  const sharedOnly = (level: AccessLevel) =>
    new FakeClient(
      ALICE,
      [vault({ owner: BOB, name: "Team infra", isOwned: false, rights: toAccessRights(level), itemIds: ["x"], fingerprint: "s" })],
      { "Team infra": [item({ id: "x", title: "Grafana" })] },
    );

  it("lands on it rather than on nothing", async () => {
    signedInAs(ALICE, sharedOnly("ReadWrite"));
    render(<App />);

    expect(await screen.findByText("Grafana")).toBeInTheDocument();
    expect(screen.queryByText(/no vaults yet/i)).not.toBeInTheDocument();
  });

  it("withholds the owner-only actions instead of offering them to fail", async () => {
    signedInAs(ALICE, sharedOnly("ReadWriteManage"));
    render(<App />);
    await screen.findByText("Grafana");

    // Manage rights are the most a grantee can have, and none of these are
    // theirs — the canister decides ownership, and #35 tells the client.
    expect(screen.queryByRole("button", { name: /delete vault/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rename/i })).not.toBeInTheDocument();
  });

  it("still offers what a grantee may actually do", async () => {
    signedInAs(ALICE, sharedOnly("ReadWrite"));
    render(<App />);
    await screen.findByText("Grafana");

    expect(screen.getByRole("button", { name: /new item/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /new vault/i })).toBeInTheDocument();
  });
});

describe("dialogs can be got out of", () => {
  // Reported: the first-vault dialog could not be exited. It had no Cancel, and
  // no dialog handled Escape — which is the other half of the same complaint,
  // since a modal that ignores the key everyone reaches for reads as stuck.
  const press = () => fireEvent.keyDown(window, { key: "Escape" });

  it("Escape closes the first-vault dialog", async () => {
    signedInAs(ALICE, new FakeClient(ALICE, [], {}));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /create a vault/i }));
    await screen.findByRole("dialog", { name: /new vault/i });

    press();

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /copy my principal/i })).toBeInTheDocument();
  });

  it("Escape closes a typed confirmation without confirming it", async () => {
    const client = signedInAs(ALICE);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /delete vault/i }));
    await screen.findByRole("dialog", { name: /delete personal/i });

    press();

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.deleteVault).not.toHaveBeenCalled();
  });

  it("but not while a request is in flight", async () => {
    // Dismissing the dialog a pending request belongs to would leave its
    // outcome with nowhere to be reported.
    const client = signedInAs(ALICE);
    client.share.mockImplementation(() => new Promise<void>(() => {}));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /share/i }));
    fireEvent.change(await screen.findByPlaceholderText(/ryjl3/i), {
      target: { value: "aaaaa-aa" },
    });
    fireEvent.click(screen.getByRole("button", { name: /grant access/i }));

    press();

    expect(await screen.findByRole("dialog", { name: /share/i })).toBeInTheDocument();
  });
});

describe("a vault's name cannot be cleared", () => {
  // Clearing used to revert the label to the map name, which was reasonable
  // while that was something the user chose. Vaults are created with a random
  // id now, so "reset" would rename the vault to `a3f1b2c4…` — strictly worse
  // than any name they could type.
  it("offers no reset", async () => {
    signedInAs(ALICE, new FakeClient(ALICE, [vault({ displayName: "Work", itemIds: ["a"] })], {
      Personal: [item({ id: "a", title: "GitHub" })],
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /rename/i }));
    const dialog = await screen.findByRole("dialog", { name: /rename/i });

    expect(within(dialog).queryByRole("button", { name: /^reset$/i })).not.toBeInTheDocument();
  });

  it("will not submit an empty name", async () => {
    const client = signedInAs(ALICE, new FakeClient(ALICE, [vault({ displayName: "Work", itemIds: ["a"] })], {
      Personal: [item({ id: "a", title: "GitHub" })],
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /rename/i }));
    const dialog = await screen.findByRole("dialog", { name: /rename/i });

    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "   " } });

    expect(within(dialog).getByRole("button", { name: /^rename$/i })).toBeDisabled();
    expect(client.rename).not.toHaveBeenCalled();
  });
});
