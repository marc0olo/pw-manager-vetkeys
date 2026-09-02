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
import { DeleteItemDialog } from "./components/DeleteItemDialog";
import { TrashButton, TrashDialog } from "./components/TrashDialog";
import { ShareDialog } from "./components/ShareDialog";
import { Sidebar } from "./components/Sidebar";
import { CheckIcon, PencilIcon, ShareIcon, TrashIcon } from "./components/Icons";

/** How often to re-read the vault list. Queries only, so this is cheap. */
export const POLL_INTERVAL_MS = 15_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [client, setClient] = useState<VaultClient | null>(null);
  // One object, cleared as a unit on lock — see lib/vault-session for why.
  const [vaultSession, setVaultSession] = useState<VaultSessionState>(NO_VAULT_SESSION);
  const { vaults, openItems, selectedVaultId, selectedItemId, syncedAt, pane, query, sharing, wiping, renaming, trash, deleting, denials } =
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
      patch({ vaults: listed, selectedVaultId: defaultVaultId(listed), syncedAt: Date.now() });
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
    async ({ quiet = false }: { quiet?: boolean } = {}) => {
      if (!client) return;
      if (!quiet) setSyncing(true);
      const current = loads.begin();
      try {
        const next = await client.listVaults();
        // Superseded by a newer poll, or the vault locked while this was in
        // flight. Either way the result is not ours to write.
        if (!current()) return;
        const outcome = pollUpdate(vaultStateRef.current, next, Date.now());
        patch(outcome.patch);
        if (outcome.movedVault) {
          // Any banner was about the vault we just left. "You no longer have
          // access to this vault" is worse than useless once "this vault" is a
          // different one — and the notice below says what happened.
          setError(null);
        }
        if (outcome.notice) notify(outcome.notice);
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
      .openVault(summary)
      .then((items) => {
        if (!cancelled) patch({ openItems: items });
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
          patch({
            selectedVaultId: id,
            selectedItemId: null,
            openItems: null,
            pane: { mode: "view" },
            query: "",
          });
          // Errors name "this vault"; carrying one across a switch makes it a
          // false statement about the vault now on screen.
          setError(null);
        }}
        principal={client?.me.toText() ?? ""}
        onCopyPrincipal={() =>
          void copyPlain(client?.me.toText() ?? "").then(
            () => notify("Your principal is on the clipboard"),
            () => setError("The browser blocked clipboard access."),
          )
        }
        onSignOut={() => void lock("manual")}
        remainingMs={session ? session.remainingMs : null}
        sessionExpiresAt={expiresAt}
        onRefresh={() => void refresh()}
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
          patch({ selectedItemId: id, pane: { mode: "view" } });
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
                await client!.restoreItem(vault, seq);
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

      {renaming && (
        <RenameVaultDialog
          vault={vault}
          busy={busy}
          onClose={() => patch({ renaming: false })}
          onRename={(displayName) =>
            void run(
              async () => {
                await client!.rename(vault, displayName);
                patch({ renaming: false });
              },
              displayName === "" ? "Name reset" : "Vault renamed",
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

      {toast && (
        <div className="toast" role="status">
          <CheckIcon />
          {toast}
        </div>
      )}
    </div>
  );
}
