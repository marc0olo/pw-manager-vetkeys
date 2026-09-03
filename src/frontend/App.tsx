import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import type { Principal } from "@icp-sdk/core/principal";
import {
  resumeSession,
  sessionExpiresAt,
  signIn,
  signOut,
  type LockReason,
} from "./lib/auth";
import { lockVault } from "./lib/lock";
import { keyCacheName, startSession, type RunningSession } from "./lib/session";
import { CLIPBOARD_CLEAR_SECONDS, copyPlain, copySecret } from "./lib/clipboard";
import { compareItems, emptyItem, matchesQuery } from "./lib/items";
import {
  VaultClient,
  defaultVaultId,
  vaultId,
  vaultLabel,
  type AccessLevel,
  type Vault,
} from "./lib/vault";
import {
  type Attempted,
  isCapability,
  offers,
  refusalMessage,
  verdictFor,
  withDenial,
} from "./lib/capabilities";
import { pollUpdate } from "./lib/poll";
import { createLoadGuard, NO_VAULT_SESSION, type VaultSessionState } from "./lib/vault-session";
import { ItemDetail } from "./components/ItemDetail";
import { ItemEditor } from "./components/ItemEditor";
import { ItemList } from "./components/ItemList";
import { LockScreen } from "./components/LockScreen";
import { EmptyVaultDialog } from "./components/EmptyVaultDialog";
import { RenameVaultDialog } from "./components/RenameVaultDialog";
import { CreateVaultDialog } from "./components/CreateVaultDialog";
import { DeleteItemDialog } from "./components/DeleteItemDialog";
import { DeleteVaultDialog } from "./components/DeleteVaultDialog";
import { TrashButton, TrashDialog } from "./components/TrashDialog";
import { ShareDialog } from "./components/ShareDialog";
import * as seen from "./lib/seen";
import { Sidebar } from "./components/Sidebar";
import { CheckIcon, CopyIcon, PencilIcon, ShareIcon, TrashIcon } from "./components/Icons";

/** How often to re-read the vault list. Queries only, so this is cheap. */
export const POLL_INTERVAL_MS = 15_000;

/**
 * How long the sync spinner stays up for a manual check.
 *
 * Not a delay for its own sake: the request itself is faster than a frame, so
 * without a floor the only feedback a button press produced was invisible.
 */
export const MIN_SYNC_FEEDBACK_MS = 600;

/**
 * The confirmation strip.
 *
 * A component rather than inline markup because more than one screen needs it:
 * the zero-vault screen's only action is copying a principal, and the toast
 * lived past that screen's early return.
 */
function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="toast" role="status">
      <CheckIcon />
      {message}
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [client, setClient] = useState<VaultClient | null>(null);
  // One object, cleared as a unit on lock — see lib/vault-session for why.
  const [vaultSession, setVaultSession] = useState<VaultSessionState>(NO_VAULT_SESSION);
  const { vaults, openItems, selectedVaultId, selectedItemId, syncedAt, pane, query, sharing, wiping, renaming, trash, itemFacts, history, deleting, creating, deletingVault, denials } =
    vaultSession;
  // Updated synchronously by `patch` below. The poll reads state across an
  // await, and React state is not visible until the next commit — reading the
  // ref means a change made just before the await is already seen, so deleting
  // your own item cannot produce a "someone deleted this" toast.
  const vaultStateRef = useRef(NO_VAULT_SESSION);
  const patch = useCallback((fields: Partial<VaultSessionState>) => {
    vaultStateRef.current = { ...vaultStateRef.current, ...fields };
    setVaultSession(vaultStateRef.current);
  }, []);
  const [syncing, setSyncing] = useState(false);
  /**
   * Per-vault "what it held when you last looked".
   *
   * Not in `VaultSessionState`: every field there is cleared on lock because it
   * holds plaintext or an open dialog, and "since I last looked" is meaningless
   * if locking resets it. Persisted per principal instead — see lib/seen.ts.
   */
  const [marks, setMarks] = useState<seen.Marks>({});
  // Guards every load that crosses an await. See lib/vault-session: a request
  // already on the wire when the vault locks must not write the previous
  // session's vault list back into the state the lock just cleared.
  const loadsRef = useRef<ReturnType<typeof createLoadGuard> | null>(null);
  loadsRef.current ??= createLoadGuard();
  const loads = loadsRef.current;


  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lockReason, setLockReason] = useState<LockReason | null>(null);

  const notify = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast((current) => (current === text ? null : current)), 3000);
  }, []);

  // Resume a stored session only if it is still inside the idle window; a session
  // left closed for longer is refused here, with its delegation and cached vault
  // keys purged together. See lib/session.
  useEffect(() => {
    resumeSession()
      .then(({ identity: resumed, lockReason: reason }) => {
        setIdentity(resumed);
        if (reason) setLockReason(reason);
      })
      .catch(() => setIdentity(null));
  }, []);

  const connect = useCallback(async (established: Identity) => {
    setBusy(true);
    setError(null);
    const current = loads.begin();
    try {
      const vaultClient = await VaultClient.create(established);
      const listed = await vaultClient.listVaults();
      if (!current()) return;
      setClient(vaultClient);
      // Chosen here rather than left to the render, so that the vault on screen
      // and the vault every other consumer reasons about are the same one. See
      // #16: an implicit selection meant the poll ignored the open vault.
      const landing = defaultVaultId(listed);
      patch({ vaults: listed, selectedVaultId: landing, syncedAt: Date.now() });
      // Marks are per principal and survive a lock, so they are read here
      // rather than reset. First sight of a vault records it without flagging
      // it — otherwise a new device would mark everything.
      const principal = vaultClient.me.toText();
      const advanced = seen.afterPoll(listed, seen.load(principal), landing);
      seen.save(principal, advanced);
      setMarks(advanced);
    } catch (caught) {
      // A failure that belongs to an ended session must not raise a banner on
      // the locked screen.
      if (!current()) return;
      setError(message(caught));
      setIdentity(null);
    } finally {
      // Deliberately unguarded: leaving this stuck would spin forever.
      setBusy(false);
    }
  }, [loads, patch]);

  useEffect(() => {
    if (identity && !client) void connect(identity);
  }, [identity, client, connect]);

  /**
   * Re-read the vault list and reconcile the selection with it.
   *
   * One query, no key derivation — see VaultClient.listVaults. Safe to call on a
   * timer for exactly that reason.
   */
  const refresh = useCallback(
    async ({ quiet = false, manual = false }: { quiet?: boolean; manual?: boolean } = {}) => {
      if (!client) return;
      if (!quiet) setSyncing(true);
      const startedAt = Date.now();
      const current = loads.begin();
      try {
        const next = await client.listVaults();
        // Superseded by a newer poll, or the vault locked while this was in
        // flight. Either way the result is not ours to write.
        if (!current()) return;
        const outcome = pollUpdate(vaultStateRef.current, next, Date.now());
        patch(outcome.patch);
        // After the patch, so the vault the user is now on is the one whose
        // mark advances — the poll can move the selection.
        setMarks((current) => {
          const advanced = seen.afterPoll(next, current, outcome.patch.selectedVaultId ?? null);
          seen.save(client.me.toText(), advanced);
          return advanced;
        });
        if (outcome.movedVault) {
          // Any banner was about the vault we just left. "You no longer have
          // access to this vault" is worse than useless once "this vault" is a
          // different one — and the notice below says what happened.
          setError(null);
        }
        if (outcome.notice) notify(outcome.notice);
        // A manual check has to answer even when the answer is "nothing".
        // Anything that *did* change is its own feedback — the screen is
        // different — so this only speaks up when nothing is.
        if (manual && !outcome.changed && !outcome.notice) notify("Already up to date");
        if (outcome.refreshTrash) {
          // Someone else changed this vault's trash while the dialog is open.
          // A second read, guarded by the same load token: the dialog must not
          // be repopulated after a lock, and a value that arrives late is not
          // ours to write.
          const vault = vaultStateRef.current.vaults?.find(
            (candidate) => vaultId(candidate) === vaultStateRef.current.selectedVaultId,
          );
          if (vault) {
            const rows = await client.listTrash(vault);
            if (current()) patch({ trash: rows });
          }
        }
      } catch (caught) {
        // A failed poll is not worth a banner; the next one will retry.
        if (!quiet) setError(message(caught));
      } finally {
        if (manual) {
          // A query against a local replica finishes in tens of milliseconds,
          // so the spinner rendered for less than a frame and the click looked
          // ignored. Held long enough to read as an event — only for a manual
          // check, since `run` refreshes after every action and a floor there
          // would add this delay to every save.
          const elapsed = Date.now() - startedAt;
          if (elapsed < MIN_SYNC_FEEDBACK_MS) {
            await new Promise((resolve) => setTimeout(resolve, MIN_SYNC_FEEDBACK_MS - elapsed));
          }
        }
        if (!quiet) setSyncing(false);
      }
    },
    [client, notify, loads],
  );

  const run = useCallback(
    async (
      action: () => Promise<void>,
      success?: string,
      // What was attempted, so a refusal can be learned from rather than shown
      // as a raw error. Omitted for actions that cannot be refused on rights.
      attempt?: { vault: string; capability: Attempted },
    ) => {
      setBusy(true);
      setError(null);
      const open = loads.open();
      try {
        await action();
        await refresh();
        if (success) notify(success);
      } catch (caught) {
        // A lock destroys the delegation, so anything in flight rejects with a
        // signature error. That is the lock working, not something the user did
        // wrong, and it must not surface as a banner on the lock screen.
        if (!open()) return;
        // The canister is the authority on rights, and this is it answering.
        // Record it so the control stops being offered, and say it plainly
        // instead of surfacing "unauthorized" at the user.
        const refusal = attempt ? refusalMessage(caught, attempt.capability) : null;
        if (attempt && refusal) {
          patch({
            // Only a capability is worth remembering. Filing anything else
            // against the vault would withdraw a control the user has — an
            // ownership refusal recorded as a write denial is what disabled
            // adding items after a non-owner tried to empty the trash.
            ...(isCapability(attempt.capability)
              ? { denials: withDenial(vaultStateRef.current.denials, attempt.vault, attempt.capability) }
              : {}),
            // Close whatever was open to do the thing that was just refused: an
            // editor that can no longer save, or a dialog whose buttons are now
            // all dead ends, is worse than no dialog at all. An owner-only
            // refusal closes nothing — the rest of that dialog still works.
            ...(attempt.capability === "write" ? { pane: { mode: "view" as const }, wiping: false } : {}),
            ...(attempt.capability === "manage" ? { sharing: false } : {}),
          });
          notify(refusal);
          return;
        }
        setError(message(caught));
      } finally {
        // Unguarded: `busy` gates the sign-in button, so leaving it set would
        // strand the lock screen. The lock clears it too, to close the window
        // between locking and this settling.
        setBusy(false);
      }
    },
    [refresh, notify, loads, patch],
  );

  const handleSignIn = async () => {
    setBusy(true);
    setError(null);
    setLockReason(null);
    try {
      setIdentity(await signIn());
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  /**
   * The single way out of an unlocked vault, whether the user pressed Lock, went
   * idle, or the delegation expired.
   *
   * Order matters and is the invariant: derived key material goes first, then the
   * delegation, then every trace of the vault in component state. Key material
   * must never outlive the session that authorised it.
   */
  // The ref is what `lock()` reads — it must see the current session synchronously
  // to avoid tearing one down twice. The state copy is what renders the countdown.
  const sessionRef = useRef<RunningSession | null>(null);
  const [session, setSession] = useState<RunningSession | null>(null);

  const lock = useCallback(
    async (reason: LockReason) => {
      const session = sessionRef.current;
      sessionRef.current = null;
      // Whether the live client's cache was actually emptied. If it was not,
      // the purge deletes its store even though that risks stalling the next
      // sign-in — a stall is recoverable by reloading, key material is not.
      let cleared = false;
      // Ordering and failure-safety live in lib/lock, where they are tested.
      await lockVault(reason, session, {
        resetUi: (locked) => {
          // Anything already on the wire belongs to the session that just
          // ended; without this, its result lands in the state cleared below.
          loads.invalidate();
          // Otherwise the lock screen renders its sign-in button disabled and
          // reading "Unlocking…" until a request killed by the lock settles.
          setBusy(false);
          // Wholesale, not field by field: that is what stops decrypted items
          // and a draft password surviving into the next session.
          vaultStateRef.current = NO_VAULT_SESSION;
          setVaultSession(NO_VAULT_SESSION);
          setIdentity(null);
          setClient(null);
          setError(null);
          setLockReason(locked);
        },
        clearVaultKeys: async () => {
          await client?.lock();
          // Only now is the store both empty and still open, which is the one
          // case the purge must not delete. See purgeKeyMaterial.
          cleared = client !== null;
        },
        endSession: () => signOut({ held: cleared ? keyCacheName(client!.me.toText()) : undefined }),
      });
    },
    [client, loads],
  );

  // The session's callbacks are installed once per identity, so they reach the
  // current `lock` through a ref rather than closing over a stale one.
  const lockRef = useRef(lock);
  useEffect(() => {
    lockRef.current = lock;
  }, [lock]);

  // One owner for the idle timeout, the persisted activity mark and the
  // cross-tab lock signal — see lib/session.
  useEffect(() => {
    if (!identity) return;
    const running = startSession(identity.getPrincipal().toText(), {
      onIdle: () => void lockRef.current("idle"),
      onRemoteLock: () => void lockRef.current("elsewhere"),
    });
    sessionRef.current = running;
    setSession(running);
    return () => {
      running.stop();
      if (sessionRef.current === running) sessionRef.current = null;
    };
  }, [identity]);

  // Read once: the timer below and the sidebar's read-out must agree on it.
  const expiresAt = useMemo(() => (identity ? sessionExpiresAt(identity) : null), [identity]);

  // Lock exactly when the delegation stops being valid.
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(() => void lockRef.current("expired"), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);

  // A plain lookup. The fallback that used to live here was the whole of #16:
  // it resolved a null selection for the *render* only, so the poll went on
  // reconciling against "nothing selected" while a vault was plainly on screen.
  // The selection is now chosen when the list arrives and corrected by
  // reconcile, so there is one answer and everything reads it.
  const summary = useMemo(
    () => vaults?.find((candidate) => vaultId(candidate) === selectedVaultId) ?? null,
    [vaults, selectedVaultId],
  );

  // Decrypt the selected vault, and only that one. This is the single place a
  // key is derived; the cache makes reopening free. `openItems` is cleared by a
  // poll that saw the ciphertext change, which re-runs this against the cache.
  useEffect(() => {
    if (!client || !summary || openItems !== null) return;
    let cancelled = false;
    client
      // Read together: the facts are what the detail pane needs to show an
      // authoritative "updated" and a version count, and asking for them
      // separately would render a pane with one and not the other. No key
      // derivation and no ciphertext, so the pair costs what the open cost.
      .openVault(summary)
      .then(async (items) => {
        const facts = await client.itemSummaries(summary);
        if (!cancelled) patch({ openItems: items, itemFacts: facts });
      })
      .catch((caught) => {
        if (cancelled) return;
        // Read access can be revoked while a decrypt is in flight — the one
        // remaining path that can put the word `unauthorized` in front of the
        // user. Translating is all that is needed: the next poll drops the
        // vault from the listing and reconcile moves the selection.
        //
        // Deliberately does not call refresh() here. `summary` is a reference
        // into the vaults array, so a refresh would give it a new identity,
        // re-run this effect, and fail again — a tight loop, not a retry.
        setError(refusalMessage(caught, "open") ?? message(caught));
      });

    return () => {
      cancelled = true;
    };
  }, [client, summary, openItems]);

  const vault: Vault | null = useMemo(
    () => (summary ? { ...summary, items: openItems ?? [] } : null),
    [summary, openItems],
  );

  // Recomputed rather than stored: it is a comparison of two things already in
  // state, and storing it would give it a second chance to disagree with them.
  const changedVaults = useMemo(() => seen.changed(vaults ?? [], marks), [vaults, marks]);

  const visibleItems = useMemo(
    () => (openItems ?? []).filter((item) => matchesQuery(item, query)).sort(compareItems),
    [openItems, query],
  );

  // `openItems === null` means "not decrypted yet", which the item list renders
  // as loading. Deliberately not keyed on a request being in flight: between
  // clearing openItems and the effect starting there is a tick with neither, and
  // an empty list would briefly render as “Nothing matches ''”.
  const itemsLoading = openItems === null;

  const selectedItem = openItems?.find((item) => item.id === selectedItemId) ?? null;
  // Offered unless the canister has actually refused. For a shared vault our
  // rights come back empty rather than absent (dfinity/vetkeys#438), so the
  // alternative — inferring read-only from silence — is what made every access
  // level behave like `Read`. Enforcement is unaffected: the canister decides.
  const writeVerdict = summary ? verdictFor(summary, "write", denials) : "denied";
  const manageVerdict = summary ? verdictFor(summary, "manage", denials) : "denied";
  const writable = offers(writeVerdict);
  const manageable = offers(manageVerdict);

  // Poll for changes so a newly shared vault, a new item or a revocation shows
  // up without a reload. Queries only, no key derivation — and deliberately not
  // wired to the activity mark, or a background timer would hold the vault
  // unlocked forever.
  useEffect(() => {
    if (!client) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh({ quiet: true });
    };
    const poller = setInterval(tick, POLL_INTERVAL_MS);
    // Catch up immediately on returning to the tab rather than waiting a tick.
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(poller);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [client, refresh]);

  /**
   * Your own principal, on the clipboard.
   *
   * Not a secret, so `copyPlain` rather than `copySecret` — nothing to clear
   * afterwards. Lifted out of the sidebar because the zero-vault screen needs
   * it too: someone who wants a vault shared *with* them has to hand over this
   * string, and it used to live only behind a screen they could not reach
   * without creating a vault first.
   */
  const copyPrincipal = () => {
    void copyPlain(client?.me.toText() ?? "").then(
      () => notify("Your principal is on the clipboard"),
      () => setError("The browser blocked clipboard access."),
    );
  };

  const copyField = async (field: "username" | "password" | "url", value: string) => {
    try {
      if (field === "password") {
        await copySecret(value);
        notify(`Password copied — clipboard clears in ${CLIPBOARD_CLEAR_SECONDS}s`);
      } else {
        await copyPlain(value);
        notify(`${field === "url" ? "Website" : "Username"} copied`);
      }
    } catch {
      setError("The browser blocked clipboard access.");
    }
  };

  if (!identity) {
    return <LockScreen onSignIn={handleSignIn} busy={busy} error={error} lockReason={lockReason} />;
  }

  // No vaults at all, which is now a real state rather than one the client
  // papered over with a synthesised `Personal`. Reachable for a brand-new user
  // and for anyone who deletes their last vault.
  //
  // Both ways out are offered, because having no vaults does not mean wanting
  // one: a user may only ever want vaults shared *with* them, and to be shared
  // with they have to hand over their principal. Offering creation alone made
  // that a dead end — the one thing needed to leave the state was the one thing
  // the state hid, since the principal lives in the sidebar below.
  //
  // Nothing else is needed for the second path: the poll is registered above
  // this return, so a vault shared while the user sits here appears within the
  // interval, with no reload and no re-authentication.
  if (vaults !== null && vaults.length === 0) {
    return (
      <>
        <main className="loading">
          <div className="empty">
            <p>You have no vaults yet.</p>
            <p className="pane__hint">
              A vault holds a set of secrets under its own key. Create one to store your own
              secrets — or share your principal, and anything shared with you appears here.
            </p>
            <code className="empty__principal">{client?.me.toText() ?? ""}</code>
            <div className="empty__actions">
              <button className="btn btn--primary" onClick={() => patch({ creating: true })}>
                Create a vault
              </button>
              <button className="btn btn--ghost" onClick={copyPrincipal}>
                <CopyIcon />
                Copy my principal
              </button>
              <button className="btn btn--ghost" onClick={() => void lock("manual")}>
                Sign out
              </button>
            </div>
            {/*
              Feedback for the copy button above. The toast used to be rendered
              only by the main view, which is past this early return — so the
              one screen whose whole purpose is copying a principal was the one
              screen that could not say it had worked.
            */}
            {error && (
              <p className="banner banner--error" role="alert">
                {error}
              </p>
            )}
          </div>
        </main>
        <Toast message={toast} />
        {creating && (
          <CreateVaultDialog
            busy={busy}
            vaults={vaults ?? []}
            first
            onClose={() => patch({ creating: false })}
            onCreate={(displayName) =>
              void run(async () => {
                const name = await client!.createVault(displayName);
                // Land on it. `run` refreshes, so the poll brings it into the
                // listing and reconcile keeps this selection because the id
                // matches — built the same way `vaultId` builds one.
                patch({
                  creating: false,
                  selectedVaultId: vaultId({ owner: identity!.getPrincipal(), name }),
                });
              }, "Vault created")
            }
          />
        )}
      </>
    );
  }

  if (!vault) {
    return (
      <main className="loading">
        <p>{error ?? "Deriving your vault key…"}</p>
        {error && (
          <button className="btn btn--ghost" onClick={() => void lock("manual")}>
            Sign out
          </button>
        )}
      </main>
    );
  }

  return (
    <div className="app">
      <Sidebar
        vaults={vaults ?? []}
        selectedId={vaultId(vault)}
        onSelect={(id) => {
          // Opening it is what "I looked" means, so the flag clears here rather
          // than on the next poll.
          setMarks((current) => {
            const marked = seen.afterViewing(vaults ?? [], current, id);
            if (client) seen.save(client.me.toText(), marked);
            return marked;
          });
          patch({
            selectedVaultId: id,
            selectedItemId: null,
            openItems: null,
            // Both belong to the vault being left. `itemFacts` must go or the
            // detail pane would show the previous vault's version counts
            // against this vault's items.
            itemFacts: null,
            history: null,
            pane: { mode: "view" },
            query: "",
          });
          // Errors name "this vault"; carrying one across a switch makes it a
          // false statement about the vault now on screen.
          setError(null);
        }}
        principal={client?.me.toText() ?? ""}
        onCopyPrincipal={() => copyPrincipal()
        }
        onSignOut={() => void lock("manual")}
        remainingMs={session ? session.remainingMs : null}
        sessionExpiresAt={expiresAt}
        onRefresh={() => void refresh({ manual: true })}
        onNewVault={() => patch({ creating: true })}
        changed={changedVaults}
        onShowChanged={() => {
          const first = changedVaults[0];
          if (first === undefined) return;
          setMarks((current) => {
            const marked = seen.afterViewing(vaults ?? [], current, first);
            if (client) seen.save(client.me.toText(), marked);
            return marked;
          });
          patch({
            selectedVaultId: first,
            selectedItemId: null,
            openItems: null,
            itemFacts: null,
            history: null,
            pane: { mode: "view" },
            query: "",
          });
        }}
        syncing={syncing}
        syncedAt={syncedAt}
      />

      <ItemList
        vault={vault}
        items={visibleItems}
        query={query}
        onQueryChange={(next) => patch({ query: next })}
        selectedId={selectedItem?.id ?? null}
        onSelect={(id) => {
          // Drop the version list read for the item being left. The render is
          // keyed to `itemId` so a stale one is never shown; this just stops it
          // being held for longer than it is useful.
          patch({ selectedItemId: id, pane: { mode: "view" }, history: null });
        }}
        onNew={() => patch({ pane: { mode: "edit", item: emptyItem(), isNew: true } })}
        canWrite={writable}
        loading={itemsLoading}
      />

      <main className="pane">
        <header className="pane__bar">
          <div className="pane__title">
            {vaultLabel(vault)}
            {!vault.isOwned && <span className="tag">shared by {vault.owner.toText().slice(0, 8)}…</span>}
          </div>
          <div className="pane__tools">
            {manageable && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => patch({ sharing: true })}
                title={
                  vault.sharedWith.length > 0
                    ? "Manage who can open this vault"
                    : "Give someone else access to this vault"
                }
                // Stable, unlike the visible text, which changes to "Shared
                // with 3" once there are members — so the control announces
                // itself differently depending on state.
                aria-label="Share this vault"
              >
                <ShareIcon />
                {vault.sharedWith.length > 0 ? `Shared with ${vault.sharedWith.length}` : "Share"}
              </button>
            )}
            {vault.isOwned && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => patch({ renaming: true })}
                title="Change what this vault is called"
              >
                <PencilIcon />
                Rename
              </button>
            )}
            {/*
              Not gated on write: trash belongs to the vault, so anyone who can
              read it can see what was deleted. The dialog withholds recovery
              instead, since that is what needs write access.
            */}
            <TrashButton
              count={vault.trashed}
              onOpen={() =>
                void run(async () => {
                  patch({ trash: await client!.listTrash(vault) });
                })
              }
            />
            {vault.isOwned && (
              <button
                className="btn btn--danger btn--sm"
                onClick={() => patch({ deletingVault: true })}
                title="Delete this vault, everything in it, and its sharing"
              >
                <TrashIcon />
                Delete vault
              </button>
            )}
            {writable && vault.itemIds.length > 0 && (
              <button
                className="btn btn--danger btn--sm"
                onClick={() => patch({ wiping: true })}
                title="Delete every item in this vault"
              >
                <TrashIcon />
                Empty vault
              </button>
            )}
          </div>
        </header>

        {error && (
          <p className="banner banner--error" role="alert">
            {error}
            <button className="linkBtn" onClick={() => setError(null)}>
              Dismiss
            </button>
          </p>
        )}

        {pane.mode === "edit" ? (
          <ItemEditor
            item={pane.item}
            isNew={pane.isNew}
            saving={busy}
            onCancel={() => patch({ pane: { mode: "view" } })}
            onSave={(item) =>
              run(
                async () => {
                  await client!.saveItem(vault, item);
                  patch({ selectedItemId: item.id, pane: { mode: "view" } });
                },
                pane.isNew ? "Item saved" : "Changes saved",
                { vault: vaultId(vault), capability: "write" },
              )
            }
          />
        ) : selectedItem ? (
          <ItemDetail
            item={selectedItem}
            canWrite={writable}
            isOwner={vault.isOwned}
            facts={itemFacts?.[selectedItem.id] ?? null}
            versions={history?.itemId === selectedItem.id ? history.rows : null}
            busy={busy}
            onToggleHistory={() =>
              history?.itemId === selectedItem.id
                ? patch({ history: null })
                : void run(async () => {
                    patch({ history: { itemId: selectedItem.id, rows: await client!.versions(vault, selectedItem.id) } });
                  })
            }
            onRestoreVersion={(seq) =>
              void run(
                async () => {
                  await client!.restoreVersion(vault, seq);
                  // The restore replaced the live value, so the open items and
                  // the per-item facts are both stale.
                  patch({ openItems: null, history: null });
                },
                "Version restored",
                { vault: vaultId(vault), capability: "write" },
              )
            }
            onDropHistory={() =>
              void run(
                async () => {
                  await client!.dropHistory(vault, selectedItem.id);
                  patch({ history: null });
                },
                "Stored versions deleted",
                // Owner-only, like emptying the trash — not a capability to be
                // discovered, so a refusal must not be filed against write.
                { vault: vaultId(vault), capability: "own" },
              )
            }
            onCopy={copyField}
            onEdit={() => patch({ pane: { mode: "edit", item: selectedItem, isNew: false } })}
            onDelete={() => patch({ deleting: true })}
          />
        ) : (
          <div className="pane__empty">
            <p>Select an item to see its details.</p>
            <p className="pane__hint">
              Secrets are decrypted in this tab only. Locking the vault discards the key material.
            </p>
          </div>
        )}
      </main>

      {trash !== null && (
        <TrashDialog
          vault={vault}
          items={trash}
          busy={busy}
          canRestore={writable}
          canEmpty={vault.isOwned}
          onClose={() => patch({ trash: null })}
          onRestore={(seq) =>
            void run(
              async () => {
                await client!.restoreVersion(vault, seq);
                patch({ trash: await client!.listTrash(vault), openItems: null });
              },
              "Item restored",
              { vault: vaultId(vault), capability: "write" },
            )
          }
          onDiscardAll={() =>
            void run(
              async () => {
                await client!.discardTrash(vault);
                patch({ trash: null });
              },
              "Trash emptied",
              // Owner-only, and ownership is known locally — so this is a
              // label for a refusal that should never arrive, not a capability
              // to be discovered.
              { vault: vaultId(vault), capability: "own" },
            )
          }
          onRestoreAll={() =>
            void run(
              async () => {
                const n = await client!.restoreAll(vault);
                patch({ trash: null, openItems: null });
                notify(`${n} item${n === 1 ? "" : "s"} restored`);
              },
              undefined,
              { vault: vaultId(vault), capability: "write" },
            )
          }
        />
      )}

      {creating && (
        <CreateVaultDialog
          busy={busy}
          vaults={vaults ?? []}
          first={false}
          onClose={() => patch({ creating: false })}
          onCreate={(displayName) =>
            void run(async () => {
              const name = await client!.createVault(displayName);
              patch({
                creating: false,
                selectedVaultId: vaultId({ owner: identity!.getPrincipal(), name }),
                selectedItemId: null,
                openItems: null,
                itemFacts: null,
                history: null,
                pane: { mode: "view" },
                query: "",
              });
            }, "Vault created")
          }
        />
      )}

      {deletingVault && (
        <DeleteVaultDialog
          vault={vault}
          busy={busy}
          onClose={() => patch({ deletingVault: false })}
          onConfirm={() =>
            void run(async () => {
              await client!.deleteVault(vault);
              // Everything on screen belonged to it. The refresh inside `run`
              // re-reads the listing and reconcile picks a surviving vault, or
              // the zero-vault state renders if there is none.
              patch({
                deletingVault: false,
                selectedVaultId: null,
                selectedItemId: null,
                openItems: null,
                itemFacts: null,
                history: null,
                trash: null,
                pane: { mode: "view" },
                query: "",
              });
            }, "Vault deleted")
          }
        />
      )}

      {renaming && (
        <RenameVaultDialog
          vault={vault}
          vaults={vaults ?? []}
          busy={busy}
          onClose={() => patch({ renaming: false })}
          onRename={(displayName) =>
            void run(
              async () => {
                await client!.rename(vault, displayName);
                patch({ renaming: false });
              },
              "Vault renamed",
            )
          }
        />
      )}

      {deleting && selectedItem && (
        <DeleteItemDialog
          item={selectedItem}
          busy={busy}
          onClose={() => patch({ deleting: false })}
          onConfirm={() =>
            void run(
              async () => {
                await client!.deleteItem(vault, selectedItem.id);
                patch({ deleting: false, selectedItemId: null });
              },
              "Item deleted",
              { vault: vaultId(vault), capability: "write" },
            )
          }
        />
      )}

      {wiping && (
        <EmptyVaultDialog
          vault={vault}
          busy={busy}
          onClose={() => patch({ wiping: false })}
          onConfirm={() =>
            void run(
              async () => {
                await client!.wipe(vault);
                patch({ wiping: false, selectedItemId: null, openItems: null });
              },
              "Vault emptied",
              { vault: vaultId(vault), capability: "write" },
            )
          }
        />
      )}

      {sharing && (
        <ShareDialog
          vault={vault}
          busy={busy}
          onClose={() => patch({ sharing: false })}
          onShare={(user: Principal, level: AccessLevel) =>
            void run(() => client!.share(vault, user, level), "Access granted", {
              vault: vaultId(vault),
              capability: "manage",
            })
          }
          onRevoke={(user: Principal) =>
            void run(() => client!.revoke(vault, user), "Access revoked", {
              vault: vaultId(vault),
              capability: "manage",
            })
          }
        />
      )}

      <Toast message={toast} />
    </div>
  );
}
