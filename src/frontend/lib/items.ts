/**
 * The item model.
 *
 * Everything a user types lives inside `VaultItem` and is stored as one
 * encrypted blob. Only the item's `id` travels to the canister in the clear
 * (EncryptedMaps encrypts values, not keys), which is why the id is opaque
 * random bytes and carries no hint of the title or site.
 */
export interface VaultItem {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  updatedAt: number;
}

/** An id is also the map key, which the canister caps at 32 bytes. */
export function newItemId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function emptyItem(): VaultItem {
  return { id: newItemId(), title: "", username: "", password: "", url: "", notes: "", updatedAt: 0 };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeItem(item: VaultItem): Uint8Array {
  return encoder.encode(JSON.stringify(item));
}

/** Tolerates a blob written by an older or broken client rather than losing the whole vault. */
export function decodeItem(id: string, bytes: Uint8Array): VaultItem {
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as Partial<VaultItem>;
    return {
      id,
      title: parsed.title ?? "",
      username: parsed.username ?? "",
      password: parsed.password ?? "",
      url: parsed.url ?? "",
      notes: parsed.notes ?? "",
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return { ...emptyItem(), id, title: "(unreadable item)" };
  }
}

/** Host part of the URL, for the item subtitle and the letter avatar. */
export function displayHost(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.replace(/^www\./, "");
  } catch {
    return trimmed;
  }
}

export function matchesQuery(item: VaultItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  // The password is deliberately not searchable.
  return [item.title, item.username, item.url, item.notes].some((field) => field.toLowerCase().includes(q));
}

export function compareItems(a: VaultItem, b: VaultItem): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
}
