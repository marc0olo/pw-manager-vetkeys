import { describe, expect, it } from "vitest";
import { IndexedDbDerivedKeyMaterialCache } from "@icp-sdk/vetkeys/encrypted_maps";

/**
 * The safety claim behind skipping the delete in `purgeKeyMaterial`: clearing
 * the cache removes the key material, so the store left behind is an empty
 * shell rather than a copy of anyone's keys.
 *
 * Asserted twice — once through the SDK's own accessor, and once by counting
 * records in the raw object store, because "the SDK cannot find it any more" is
 * a weaker statement than "it is not there".
 */

const STORE = "derived-key-material";

/** Record count in the raw object store, bypassing the SDK entirely. */
function rawCount(dbName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.close();
        resolve(0);
        return;
      }
      const count = db.transaction(STORE, "readonly").objectStore(STORE).count();
      count.onsuccess = () => {
        db.close();
        resolve(count.result);
      };
      count.onerror = () => {
        db.close();
        reject(count.error);
      };
    };
  });
}

describe("clearing the derived-key-material cache", () => {
  it("leaves nothing behind, and leaves the store openable", async () => {
    const name = "vetvault-keys-clear-test";
    const cache = new IndexedDbDerivedKeyMaterialCache(name);

    // Stand-in for a derived key handle; the cache stores whatever it is given.
    await cache.set("owner|abcdef", { secret: "key-material" } as never);
    expect(await cache.get("owner|abcdef")).toBeTruthy();
    expect(await rawCount(name)).toBe(1);

    await cache.clear();

    // Through the SDK…
    expect(await cache.get("owner|abcdef")).toBeUndefined();
    // …and independently of it. This is the assertion that matters: the store
    // that `purgeKeyMaterial` deliberately does not delete holds no records.
    expect(await rawCount(name)).toBe(0);
  });

  it("does not close the connection, which is why the delete had to be skipped", async () => {
    // Not a wish — a fact about `idb-keyval`, and the reason a queued delete
    // could never complete. If a future version closes on clear, deleting a
    // held store becomes safe again and the skip can go.
    const cache = new IndexedDbDerivedKeyMaterialCache("vetvault-keys-close-test");
    await cache.set("k", { v: 1 } as never);
    await cache.clear();

    expect("close" in cache).toBe(false);
  });
});
