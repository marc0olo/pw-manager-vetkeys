import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import type { Principal } from "@icp-sdk/core/principal";
import {
  onIdle,
  restoreSession,
  sessionExpiresAt,
  signIn,
  signOut,
  type LockReason,
} from "./lib/auth";
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

  // Restore an existing delegation on load, but never auto-derive vault keys:
  // key material is in-memory only, so a reload really does lock the vault.
  useEffect(() => {
    restoreSession()
      .then(setIdentity)
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
  const lock = useCallback(
    async (reason: LockReason) => {
      await client?.lock();
      await signOut();
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
    },
    [client],
  );

  // The idle callback is registered once, so it has to reach the current `lock`
  // and identity through refs rather than closing over stale ones.
  const lockRef = useRef(lock);
  const identityRef = useRef(identity);
  useEffect(() => {
    lockRef.current = lock;
    identityRef.current = identity;
  }, [lock, identity]);

  useEffect(() => {
    onIdle(() => {
      // The idle timer runs while locked too; ignore it then.
      if (identityRef.current) void lockRef.current("idle");
    });
  }, []);

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
