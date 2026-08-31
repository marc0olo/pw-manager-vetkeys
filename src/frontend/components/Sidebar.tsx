import { CopyIcon, LockIcon, RefreshIcon, ShareIcon, ShieldIcon } from "./Icons";
import { SessionStatus } from "./SessionStatus";
import { accessLevel, vaultId, vaultLabel, type VaultSummary } from "../lib/vault";

interface Props {
  vaults: VaultSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  principal: string;
  onCopyPrincipal: () => void;
  onSignOut: () => void;
  /** Live remaining time before the idle lock; absent while locked. */
  remainingMs: (() => number) | null;
  /** When the delegation stops being valid, in ms since the epoch. */
  sessionExpiresAt: number | null;
  onRefresh: () => void;
  syncing: boolean;
  /** When the vault list was last read, in ms since the epoch. */
  syncedAt: number | null;
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

const LEVEL_LABEL = { Read: "read-only", ReadWrite: "can edit", ReadWriteManage: "can manage" } as const;

export function Sidebar({
  vaults,
  selectedId,
  onSelect,
  principal,
  onCopyPrincipal,
  onSignOut,
  remainingMs,
  sessionExpiresAt,
  onRefresh,
  syncing,
  syncedAt,
}: Props) {
  const owned = vaults.filter((vault) => vault.isOwned);
  const shared = vaults.filter((vault) => !vault.isOwned);

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark">
          <ShieldIcon />
        </span>
        vetVault
        {/* App-scoped: it re-reads the vault list, not one vault's contents, so
            it belongs beside the app name rather than in a vault's own header. */}
        <button
          className={`iconBtn sidebar__sync ${syncing ? "sidebar__sync--busy" : ""}`}
          onClick={onRefresh}
          disabled={syncing}
          title={`Check for changes${syncedAt === null ? "" : ` — last checked ${relativeTime(syncedAt)}`}`}
          aria-label="Check for changes"
        >
          <RefreshIcon />
        </button>
      </div>

      <nav className="sidebar__nav">
        <VaultGroup title="My vault" vaults={owned} selectedId={selectedId} onSelect={onSelect} />
        {shared.length > 0 && (
          <VaultGroup title="Shared with me" vaults={shared} selectedId={selectedId} onSelect={onSelect} />
        )}
      </nav>

      <div className="sidebar__foot">
        <div className="sidebar__who">
          <span className="sidebar__whoLabel">Signed in as</span>
          <div className="sidebar__whoRow">
            <code title={principal}>{principal}</code>
            <button
              className="iconBtn"
              onClick={onCopyPrincipal}
              title="Copy your principal, so someone can share a vault with you"
              aria-label="Copy your principal"
            >
              <CopyIcon />
            </button>
          </div>
        </div>

        {remainingMs && <SessionStatus remainingMs={remainingMs} expiresAt={sessionExpiresAt} />}

        <button className="btn btn--ghost btn--full" onClick={onSignOut}>
          <LockIcon />
          Lock vault
        </button>
      </div>
    </aside>
  );
}

function VaultGroup({
  title,
  vaults,
  selectedId,
  onSelect,
}: {
  title: string;
  vaults: VaultSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="sidebar__group">
      <h2 className="sidebar__groupTitle">{title}</h2>
      <ul>
        {vaults.map((vault) => {
          const id = vaultId(vault);
          const sharedCount = vault.sharedWith.length;
          return (
            <li key={id}>
              <button
                className={`vaultRow ${selectedId === id ? "vaultRow--active" : ""}`}
                onClick={() => onSelect(id)}
              >
                <span className="vaultRow__name">{vaultLabel(vault)}</span>
                <span className="vaultRow__count">{vault.itemIds.length}</span>
                {vault.isOwned && sharedCount > 0 && (
                  <span
                    className="vaultRow__meta vaultRow__meta--shared"
                    title={`Shared with ${sharedCount} ${sharedCount === 1 ? "person" : "people"}`}
                  >
                    <ShareIcon />
                    Shared with {sharedCount}
                  </span>
                )}
                {!vault.isOwned && vault.rights && (
                  <span className="vaultRow__meta">
                    {vault.owner.toText().slice(0, 5)}… · {LEVEL_LABEL[accessLevel(vault.rights)]}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
