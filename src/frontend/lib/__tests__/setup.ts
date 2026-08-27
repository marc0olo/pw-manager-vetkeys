// jsdom has no IndexedDB and no BroadcastChannel; the session logic needs both.
import "fake-indexeddb/auto";
import { BroadcastChannel } from "node:worker_threads";

if (typeof globalThis.BroadcastChannel === "undefined") {
  // Node's implementation is API-compatible for postMessage/onmessage/close.
  globalThis.BroadcastChannel = BroadcastChannel as unknown as typeof globalThis.BroadcastChannel;
}
