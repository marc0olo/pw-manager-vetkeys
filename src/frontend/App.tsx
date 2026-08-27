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
} from "./lib/vault";
import { ItemDetail } from "./components/ItemDetail";
import { ItemEditor } from "./components/ItemEditor";
import { ItemList } from "./components/ItemList";
import { LockScreen } from "./components/LockScreen";
import { ShareDialog } from "./components/ShareDialog";
import { Sidebar } from "./components/Sidebar";
import { CheckIcon, CopyIcon, ShareIcon } from "./components/Icons";

type Pane = { mode: "view" } | { mode: "edit"; item: VaultItem; isNew: boolean };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [client, setClient] = useState<VaultClient | null>(null);
  const [vaults, setVaults] = useState<Vault[] | null>(null);

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
      setVaults(await vaultClient.loadVaults());
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

  const refresh = useCallback(async () => {
    if (!client) return;
    setVaults(await client.loadVaults());
  }, [client]);

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
  const sessionRef = useRef<RunningSession | null>(null);

  const lock = useCallback(
    async (reason: LockReason) => {
      const session = sessionRef.current;
      sessionRef.current = null;

      // Take the UI out of the unlocked state FIRST, so nothing can start new
      // work against the vault while the teardown runs — a save landing
      // mid-purge would re-create the key store after it was deleted.
      setIdentity(null);
      setClient(null);
      setVaults(null);
      setSelectedVaultId(null);
      setSelectedItemId(null);
      setPane({ mode: "view" });
      setQuery("");
      setSharing(false);
      setError(null);
      setLockReason(reason);

      session?.stop();
      // Locking anywhere locks everywhere, except when this lock *came* from
      // another tab — that would bounce the message back and forth.
      if (reason !== "elsewhere") session?.broadcastLock();

      // Each step is independent and must run even if an earlier one throws:
      // failing halfway would leave the delegation or the persisted key store
      // behind, which is the dangerous direction.
      try {
        await client?.lock();
      } catch {
        /* signOut() purges the store anyway */
      }
      try {
        await signOut();
      } catch {
        /* the UI is already locked; nothing further to do */
      }
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
    const session = startSession(identity.getPrincipal().toText(), {
      onIdle: () => void lockRef.current("idle"),
      onRemoteLock: () => void lockRef.current("elsewhere"),
    });
    sessionRef.current = session;
    return () => {
      session.stop();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [identity]);

  // Lock exactly when the delegation stops being valid.
  useEffect(() => {
    if (!identity) return;
    const expiresAt = sessionExpiresAt(identity);
    if (expiresAt === null) return;
    const timer = setTimeout(() => void lockRef.current("expired"), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [identity]);

  const vault = useMemo(() => {
    if (!vaults?.length) return null;
    return vaults.find((candidate) => vaultId(candidate) === selectedVaultId) ?? vaults[0];
  }, [vaults, selectedVaultId]);

  const visibleItems = useMemo(
    () => (vault ? vault.items.filter((item) => matchesQuery(item, query)).sort(compareItems) : []),
    [vault, query],
  );

  const selectedItem = vault?.items.find((item) => item.id === selectedItemId) ?? null;
  const writable = vault !== null && canWrite(vault);

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
          setPane({ mode: "view" });
          setQuery("");
        }}
        principal={client?.me.toText() ?? ""}
        onSignOut={() => void lock("manual")}
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
      />

      <main className="pane">
        <header className="pane__bar">
          <div className="pane__title">
            {vault.name}
            {!vault.isOwned && <span className="tag">shared by {vault.owner.toText().slice(0, 8)}…</span>}
          </div>
          <div className="pane__tools">
            <button
              className="btn btn--ghost btn--sm"
              onClick={() =>
                void copyPlain(client?.me.toText() ?? "").then(
                  () => notify("Your principal is on the clipboard"),
                  () => setError("The browser blocked clipboard access."),
                )
              }
              title="Copy your principal so someone can share a vault with you"
            >
              <CopyIcon />
              My principal
            </button>
            {canManage(vault) && (
              <button className="btn btn--ghost btn--sm" onClick={() => setSharing(true)}>
                <ShareIcon />
                Share
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
