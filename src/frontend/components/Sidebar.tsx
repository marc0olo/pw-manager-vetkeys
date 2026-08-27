import { LockIcon, ShieldIcon } from "./Icons";
import { accessLevel, vaultId, type Vault } from "../lib/vault";

interface Props {
  vaults: Vault[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  principal: string;
  onSignOut: () => void;
}

const LEVEL_LABEL = { Read: "read-only", ReadWrite: "can edit", ReadWriteManage: "can manage" } as const;

export function Sidebar({ vaults, selectedId, onSelect, principal, onSignOut }: Props) {
  const owned = vaults.filter((vault) => vault.isOwned);
  const shared = vaults.filter((vault) => !vault.isOwned);

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark">
          <ShieldIcon />
        </span>
        vetVault
      </div>

      <nav className="sidebar__nav">
        <VaultGroup
          title="My vault"
          vaults={owned}
          selectedId={selectedId}
          onSelect={onSelect}
        />
        {shared.length > 0 && (
          <VaultGroup
            title="Shared with me"
            vaults={shared}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        )}
      </nav>

      <div className="sidebar__foot">
        <div className="sidebar__who" title={principal}>
          <span className="sidebar__whoLabel">Signed in as</span>
          <code>{principal}</code>
        </div>
        <button className="btn btn--ghost btn--full" onClick={onSignOut}>
          <LockIcon />
          Lock vault
        </button>
      </div>
    </aside>
  );
}

function VaultGroup({ title, vaults, selectedId, onSelect }: Omit<Props, "principal" | "onSignOut"> & { title: string }) {
  return (
    <div className="sidebar__group">
      <h2 className="sidebar__groupTitle">{title}</h2>
      <ul>
        {vaults.map((vault) => {
          const id = vaultId(vault);
          return (
            <li key={id}>
              <button
                className={`vaultRow ${selectedId === id ? "vaultRow--active" : ""}`}
                onClick={() => onSelect(id)}
              >
                <span className="vaultRow__name">{vault.name}</span>
                <span className="vaultRow__count">{vault.items.length}</span>
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
