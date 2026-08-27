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
import { startSession, type RunningSession } from "./lib/session";
import { CLIPBOARD_CLEAR_SECONDS, copyPlain, copySecret } from "./lib/clipboard";
import { compareItems, emptyItem, matchesQuery, type VaultItem } from "./lib/items";
import {
  canManage,
  canWrite,
  VaultClient,
  vaultId,
  type AccessLevel,
  type Vault,
  type VaultSummary,
} from "./lib/vault";
import { reconcile } from "./lib/reconcile";
import { ItemDetail } from "./components/ItemDetail";
import { ItemEditor } from "./components/ItemEditor";
import { ItemList } from "./components/ItemList";
import { LockScreen } from "./components/LockScreen";
import { ShareDialog } from "./components/ShareDialog";
import { Sidebar } from "./components/Sidebar";
import { CheckIcon, ShareIcon } from "./components/Icons";

/** How often to re-read the vault list. Queries only, so this is cheap. */
const POLL_INTERVAL_MS = 15_000;

type Pane = { mode: "view" } | { mode: "edit"; item: VaultItem; isNew: boolean };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [client, setClient] = useState<VaultClient | null>(null);
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [openItems, setOpenItems] = useState<VaultItem[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pane, setPane] = useState<Pane>({ mode: "view" });
  const [sharing, setSharing] = useState(false);

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
    try {
      const vaultClient = await VaultClient.create(established);
      setClient(vaultClient);
      setVaults(await vaultClient.listVaults());
      setSyncedAt(Date.now());
    } catch (caught) {
      setError(message(caught));
      setIdentity(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (identity && !client) void connect(identity);
  }, [identity, client, connect]);

  // Refs so the poll can read current state without re-arming on every change.
  const selectionRef = useRef({ vaultId: selectedVaultId, itemId: selectedItemId });
  const vaultsRef = useRef(vaults);
  const openItemsRef = useRef(openItems);
  useEffect(() => {
    selectionRef.current = { vaultId: selectedVaultId, itemId: selectedItemId };
    vaultsRef.current = vaults;
    openItemsRef.current = openItems;
  }, [selectedVaultId, selectedItemId, vaults, openItems]);

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
      try {
        const next = await client.listVaults();
        const previous = vaultsRef.current ?? [];
        setVaults(next);
        setSyncedAt(Date.now());

        const outcome = reconcile({
          previous,
          next,
          selection: selectionRef.current,
          openItems: openItemsRef.current,
        });
        if (outcome.selection.vaultId !== selectionRef.current.vaultId) {
          setSelectedVaultId(outcome.selection.vaultId);
        }
        if (outcome.selection.itemId !== selectionRef.current.itemId) {
          setSelectedItemId(outcome.selection.itemId);
          // Whatever was on screen is gone; do not leave an editor open on it.
          setPane({ mode: "view" });
        }
        if (outcome.notice) notify(outcome.notice);
        if (outcome.refreshItems) setOpenItems(null);
      } catch (caught) {
        // A failed poll is not worth a banner; the next one will retry.
        if (!quiet) setError(message(caught));
      } finally {
        if (!quiet) setSyncing(false);
      }
    },
    [client, notify],
  );

  const run = useCallback(
    async (action: () => Promise<void>, success?: string) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
        if (success) notify(success);
      } catch (caught) {
        setError(message(caught));
      } finally {
        setBusy(false);
      }
    },
    [refresh, notify],
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
      // Ordering and failure-safety live in lib/lock, where they are tested.
      await lockVault(reason, session, {
        resetUi: (locked) => {
          setIdentity(null);
          setClient(null);
          setVaults(null);
          setSelectedVaultId(null);
          setSelectedItemId(null);
          setPane({ mode: "view" });
          setQuery("");
          setSharing(false);
          setError(null);
          setLockReason(locked);
        },
        clearVaultKeys: async () => {
          await client?.lock();
        },
        endSession: signOut,
      });
    },
    [client],
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

  const summary = useMemo(() => {
    if (!vaults?.length) return null;
    return vaults.find((candidate) => vaultId(candidate) === selectedVaultId) ?? vaults[0];
  }, [vaults, selectedVaultId]);

  // Decrypt the selected vault, and only that one. This is the single place a
  // key is derived; the cache makes reopening free. `openItems` is cleared by a
  // poll that saw the ciphertext change, which re-runs this against the cache.
  useEffect(() => {
    if (!client || !summary || openItems !== null) return;
    let cancelled = false;
    client
      .openVault(summary)
      .then((items) => {
        if (!cancelled) setOpenItems(items);
      })
      .catch((caught) => {
        if (!cancelled) setError(message(caught));
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
  const writable = summary !== null && canWrite(summary);

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
          setSelectedVaultId(id);
          setSelectedItemId(null);
          setOpenItems(null);
          setPane({ mode: "view" });
          setQuery("");
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
        onQueryChange={setQuery}
        selectedId={selectedItem?.id ?? null}
        onSelect={(id) => {
          setSelectedItemId(id);
          setPane({ mode: "view" });
        }}
        onNew={() => setPane({ mode: "edit", item: emptyItem(), isNew: true })}
        canWrite={writable}
        loading={itemsLoading}
      />

      <main className="pane">
        <header className="pane__bar">
          <div className="pane__title">
            {vault.name}
            {!vault.isOwned && <span className="tag">shared by {vault.owner.toText().slice(0, 8)}…</span>}
          </div>
          <div className="pane__tools">
            {canManage(vault) && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => setSharing(true)}
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
            onCancel={() => setPane({ mode: "view" })}
            onSave={(item) =>
              run(async () => {
                await client!.saveItem(vault, item);
                setSelectedItemId(item.id);
                setPane({ mode: "view" });
              }, pane.isNew ? "Item saved" : "Changes saved")
            }
          />
        ) : selectedItem ? (
          <ItemDetail
            item={selectedItem}
            canWrite={writable}
            onCopy={copyField}
            onEdit={() => setPane({ mode: "edit", item: selectedItem, isNew: false })}
            onDelete={() => {
              if (!window.confirm(`Delete “${selectedItem.title || "this item"}” permanently?`)) return;
              void run(async () => {
                await client!.deleteItem(vault, selectedItem.id);
                setSelectedItemId(null);
              }, "Item deleted");
            }}
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

      {sharing && (
        <ShareDialog
          vault={vault}
          busy={busy}
          onClose={() => setSharing(false)}
          onShare={(user: Principal, level: AccessLevel) =>
            void run(() => client!.share(vault, user, level), "Access granted")
          }
          onRevoke={(user: Principal) => void run(() => client!.revoke(vault, user), "Access revoked")}
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
