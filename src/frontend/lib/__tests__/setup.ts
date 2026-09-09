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
//
// Registered by hand, and not redundant: Testing Library only self-registers
// its cleanup when `globals` is on, and vitest.config.ts does not set it. So
// this line is the only thing that unmounts anything — which also makes it what
// lets components clear their timers. `App`'s toast timer is cleared on unmount
// precisely so it cannot fire after jsdom teardown; remove this and that timer
// survives its environment again, and the suite fails with every test passing.
afterEach(cleanup);

if (typeof globalThis.BroadcastChannel === "undefined") {
  // Node's implementation is API-compatible for postMessage/onmessage/close.
  globalThis.BroadcastChannel = BroadcastChannel as unknown as typeof globalThis.BroadcastChannel;
}
