// jsdom has no IndexedDB and no BroadcastChannel; the session logic needs both.
import "fake-indexeddb/auto";
import { BroadcastChannel } from "node:worker_threads";
// Adds DOM matchers (toBeInTheDocument, toBeDisabled) used by the component tests.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Component tests mount the real App. Without this, a mounted tree from one
// test is still in the document during the next, and a query for "the sign-in
// button" can match the wrong one.
afterEach(cleanup);

if (typeof globalThis.BroadcastChannel === "undefined") {
  // Node's implementation is API-compatible for postMessage/onmessage/close.
  globalThis.BroadcastChannel = BroadcastChannel as unknown as typeof globalThis.BroadcastChannel;
}
