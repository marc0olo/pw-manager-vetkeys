import { PlusIcon, SearchIcon } from "./Icons";
import { displayHost, type VaultItem } from "../lib/items";
import type { Vault } from "../lib/vault";

interface Props {
  vault: Vault;
  items: VaultItem[];
  query: string;
  onQueryChange: (query: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  canWrite: boolean;
}

export function ItemList({
  vault,
  items,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  onNew,
  canWrite,
}: Props) {
  return (
    <section className="list">
      <header className="list__head">
        <div className="search">
          <SearchIcon />
          <input
            type="search"
            value={query}
            placeholder={`Search ${vault.name}`}
            onChange={(event) => onQueryChange(event.target.value)}
            aria-label="Search items"
          />
        </div>
        <button
          className="btn btn--primary btn--icon"
          onClick={onNew}
          disabled={!canWrite}
          title={canWrite ? "New item" : "You have read-only access to this vault"}
          aria-label="New item"
        >
          <PlusIcon />
        </button>
      </header>

      {items.length === 0 ? (
        <p className="list__empty">
          {vault.items.length === 0
            ? canWrite
              ? "This vault is empty. Add your first login."
              : "This vault is empty."
            : `Nothing matches “${query}”.`}
        </p>
      ) : (
        <ul className="list__items">
          {items.map((item) => {
            const host = displayHost(item.url);
            const label = item.title || host || "Untitled";
            return (
              <li key={item.id}>
                <button
                  className={`itemRow ${selectedId === item.id ? "itemRow--active" : ""}`}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="itemRow__avatar" aria-hidden>
                    {label.charAt(0).toUpperCase()}
                  </span>
                  <span className="itemRow__text">
                    <span className="itemRow__title">{label}</span>
                    <span className="itemRow__sub">{item.username || host || "—"}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="list__foot">
        {items.length} of {vault.items.length} {vault.items.length === 1 ? "item" : "items"}
      </footer>
    </section>
  );
}
