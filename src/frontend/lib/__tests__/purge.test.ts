import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keyCacheName, purgeKeyMaterial } from "../session";

/**
 * Why a store the live client holds open must be cleared rather than deleted.
 *
 * IndexedDB refuses a delete while a connection is open and leaves it
 * **queued** — and a queued delete stalls the next `open` on that name
 * indefinitely. The SDK's cache is `idb-keyval`, which never closes its
 * connection, so the stall outlives the session: the next sign-in hangs on
 * "Decrypting…" until the page is reloaded. Observed in the app after an idle
 * lock, on a shared vault whose key had to be re-derived.
 */

const open = (name: string) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("derived-key-material");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Resolves to "opened" or "stalled" — the distinction this whole file is about. */
const canOpen = (name: string) =>
  Promise.race([
    open(name).then(
      (db) => {
        db.close();
        return "opened";
      },
      () => "errored",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), 250)),
  ]);

const listed = async () =>
  ((await indexedDB.databases?.()) ?? []).map((d) => d.name).filter(Boolean) as string[];

const MINE = keyCacheName("me-principal");
const OTHER = keyCacheName("someone-else");
let holding: IDBDatabase | null = null;

beforeEach(async () => {
  window.localStorage.setItem("vetvault:principal", "me-principal");
  // The live client's cache: open, and cleared but not closed.
  holding = await open(MINE);
  (await open(OTHER)).close();
});

afterEach(() => {
  holding?.close();
  holding = null;
  window.localStorage.clear();
});

describe("purgeKeyMaterial", () => {
  it("leaves a held store openable, so the next sign-in does not stall", async () => {
    await purgeKeyMaterial({ held: MINE });
    expect(await canOpen(MINE)).toBe("opened");
  });

  it("still deletes stores it does not hold", async () => {
    await purgeKeyMaterial({ held: MINE });
    expect(await listed()).not.toContain(OTHER);
  });

  it("deletes the held store too when not told it is held", async () => {
    // The safety fallback: if the clear failed, key material must go even at
    // the cost of a stall. This is the behaviour that caused the bug when it
    // was the *only* behaviour.
    await purgeKeyMaterial();
    expect(await canOpen(MINE)).toBe("stalled");
  });

  it("deletes everything when nothing is open", async () => {
    holding?.close();
    holding = null;
    await purgeKeyMaterial();
    const remaining = await listed();
    expect(remaining).not.toContain(MINE);
    expect(remaining).not.toContain(OTHER);
  });

  it("does not skip a store merely because a name was passed", async () => {
    await purgeKeyMaterial({ held: keyCacheName("nobody") });
    expect(await listed()).not.toContain(OTHER);
  });
});
