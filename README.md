# vetVault

A small password manager on the Internet Computer, modelled on 1Password's shape:
vaults on the left, a searchable item list in the middle, item details on the right.

Secrets are encrypted **in the browser** with [vetKeys](https://internetcomputer.org/docs/building-apps/network-features/vetkeys/introduction)
`EncryptedMaps`. The canister only ever holds ciphertext, and there is no master
password — the vault key is derived for your Internet Identity principal.

## Features

- **Internet Identity sign-in.** No account, no master password. Auto-locks after
  5 minutes idle, whether the app is open or closed.
- **Items**: title, username, password, website, notes — create, edit, delete.
- **Search** across every field except the password.
- **Password generator** with length, digits and symbols, plus a strength read-out.
- **Reveal / copy.** Passwords are masked, auto-hide after 30s, and copying one
  clears the clipboard after 45s (only if it still holds that value).
- **Vault sharing** at three levels — read, read/write, read/write/manage. The
  vault key is re-encrypted for the grantee, so no secret changes hands.
- **Lock** discards the derived key material.

## Architecture

```
src/backend/main.mo        The whole backend: EncryptedMaps state + the canister mixin
src/frontend/lib/vault.ts  Encrypt/decrypt and access control over EncryptedMaps
src/frontend/lib/items.ts  The item model and its JSON encoding
src/frontend/lib/auth.ts   Internet Identity, and the load-time session gate
src/frontend/lib/session.ts  Idle timeout, activity mark, cross-tab lock, key purge
src/frontend/components/   Sidebar, item list, detail, editor, share dialog
src/frontend/lib/__tests__/  Unit tests: session lifetime, load-time gate
scripts/smoke-test.mjs     End-to-end check against a running local replica
```

The backend is ~20 lines: `include EncryptedMapsCanister(state)` contributes every
endpoint the `@icp-sdk/vetkeys` client calls, so the Candid interface matches the
client by construction.

### What the canister can and cannot see

| Stored | Visible to the canister and node operators |
|---|---|
| Item contents (title, username, password, URL, notes) | No — one encrypted blob per item |
| Item id | Yes — so ids are random bytes and leak nothing |
| Vault name, owner, and who it is shared with | Yes — access control has to be enforced in the clear |

### What persists, and for how long

| | Where | Lifetime |
|---|---|---|
| Internet Identity delegation | IndexedDB (`@icp-sdk/auth`) | until the idle window lapses, capped at 8 h |
| Derived vault key material | IndexedDB, namespaced per principal | the same — purged with the delegation |
| Last-activity mark | `localStorage` | cleared on lock |

**One timeout governs both open and closed time.** The app auto-locks after
`idleMinutes` of inactivity while open; a session left closed for longer than
that is refused on the next load, and the delegation and every cached vault key
are purged together before anything can use them. `delegationHours` is only a
ceiling the session cannot outlive even with continuous use.

Both live in `SESSION_POLICY` in `src/frontend/lib/auth.ts`.

Why a deadline checked on load rather than clearing on close: there is no
reliable "the app was closed" hook. `pagehide`/`beforeunload` do not run on a
crash, force-quit or OS kill — so anything relying on them leaves credentials
behind exactly when it matters — and they *also* fire on an ordinary reload, so
clearing there would demand a fresh passkey on every refresh. A stored deadline
needs no cooperation from the shutdown path: whatever killed the app, the next
load refuses and purges. A missing mark counts as expired, so it fails closed.

#### Why key material is cached at all

Opening a vault costs one `vetkd_derive_key` call, so the cost scales with how
many vaults you can see — 1 owned + 25 shared is 26 derivations on **every** page
load, about 0.68 XDR on `key_1`. Caching takes a reload inside the window to zero.

What is stored is a **non-extractable `CryptoKey` handle**: `exportKey` throws, so
the raw key bytes can never leave the device. The exposure is "same-origin code
could use the handle", not "key material can be copied off the machine".

Persisting it is sound only because its lifetime is tied to the session's, which
is what the purge-on-load rule above enforces, and because the store is
namespaced per principal so one identity's keys are never served to another.

Two limits worth knowing:

- The purge enumerates stores with `indexedDB.databases()`, which **Firefox does
  not implement**. There it can only delete the last recorded principal's store,
  so a store left behind by a principal no longer recorded would survive.
- `EncryptedMaps` does not rotate a vault key when access is revoked, so a
  revoked collaborator's cached handle stays cryptographically valid. They can no
  longer fetch ciphertext, and cannot export the key — but caching widens the
  window in which they hold a usable handle from "this tab" to "the idle window".

## Run it

```bash
npm install

icp network start -d          # gateway pinned to port 8100 (see below)
icp deploy                    # builds the canister and the frontend, then syncs
```

`icp deploy` prints the frontend URL: `http://frontend.local.localhost:8100/`.

```bash
npm test                      # session lifetime and load-time gate (no replica needed)
npm run smoke-test            # crypto + access control against the deployed canister
npm run check-ii-metadata     # validates the II app-metadata document
```

### Internet Identity

**Which II** is decided at runtime from the origin the page is served from,
because a locally deployed II is served by the *same gateway* as this app:

| Served from | Internet Identity |
|---|---|
| `*.localhost` (local gateway) | `http://id.ai.localhost:<same port>/authorize` |
| anything else (mainnet, custom domain) | `https://id.ai/authorize` |

That is the whole mechanism — `resolveIdentityProvider()` in
`src/frontend/lib/auth.ts`. There is no build configuration, and a mainnet origin
cannot resolve to a localhost URL. `npm run dev` is the one exception, since Vite
serves on its own port rather than the gateway's; the dev server passes the
gateway origin in the `ic_env` cookie it already fakes.

Local Internet Identity requires `ii: true` on the local network in `icp.yaml`
(already set). A local-II build says so on the lock screen.

**The gate**: everything sensitive hangs off `VaultClient`, built only from a
non-anonymous identity, so no code path reaches an item without a delegation. The
canister enforces the same independently through EncryptedMaps access control —
the gate is defence in depth, not the security boundary.

The vault locks four ways, all through `lock(reason)` in `App.tsx`, always in the
same order — drop the derived key material, then the delegation, then all vault
state — with each step running even if an earlier one throws. Locking in one tab
broadcasts to the others, so they lock too. The lock screen says which happened.

| Trigger | When |
|---|---|
| `manual` | the **Lock vault** button |
| `idle` | 5 minutes without interaction, **or** reopening after that long away |
| `expired` | the delegation is gone, or the stored session cannot be trusted |
| `elsewhere` | another tab locked |

A reload keeps you signed in (it lands well inside the idle window) and reuses
the cached vault keys, so it costs no derivations.

The idle timeout is owned by `lib/session`, not by `@icp-sdk/auth`'s
`IdleManager`: that is created only inside `signIn()`, so a callback registered at
construction never runs, and it is single-shot. Owning it also means the in-page
timer and the persisted mark are driven by the same activity events, so the two
halves of the timeout cannot disagree.

Both halves compare against the **wall clock** rather than waiting for a timer to
fire. Timers do not run while a page is frozen or the machine is asleep, and a
pending timeout resumes with its original remaining delay — so a lid closed for an
hour would otherwise reopen on a decrypted vault with minutes still to run.

> **Principals are per origin.** `http://localhost:5173` (`npm run dev`),
> `http://frontend.local.localhost:8100` (deployed locally) and mainnet are three
> different users with three different vaults.

### Why the gateway port is pinned

II derives a principal per origin, and the port is part of the origin. With an
OS-assigned port (`gateway.port: 0`) every `icp network start` would hand you a
new principal — and an apparently empty vault. The port is pinned to **8100**
(not the icp-cli default of 8000, so this project coexists with others). If 8100
is taken, change it in `icp.yaml`; everything else reads the port dynamically.

### Mainnet

```bash
icp identity default <your-identity>   # never deploy to mainnet as anonymous
icp deploy -e ic
```

Before that, change `VETKD_KEY_NAME` in `icp.yaml` from `test_key_1` to `key_1`.

Internet Identity needs no configuration — a mainnet origin resolves to
`https://id.ai/authorize` on its own. Do **not** add `derivationOrigin` for the
gateway domains: II canonicalizes `ic0.app`, `icp0.io` and `icp.net` to one form,
so they already yield the same principal, and adding it would break sign-in.

The sign-in screen shows this app's name, tagline and logo from
`public/.well-known/ii-app-metadata`. Its rules fail as a unit — one invalid field
voids the whole document — so run `npm run check-ii-metadata` after editing it.

> **The vetKD key name and the domain separator are immutable once data exists.**
> Both feed key derivation, so changing either makes every stored secret
> undecryptable. In Motoko the key name is captured into stable state at first
> install — editing it on a later upgrade is silently ignored, and only a
> `reinstall` (which drops all data) switches keys. Because `test_key_1` is also a
> valid mainnet key, a production deploy that forgets to set `VETKD_KEY_NAME`
> silently runs on it.

## Known limitations

- **One owned vault.** The canister lists only *non-empty* owned vaults, so an
  empty vault cannot be persisted without extra backend metadata. You get one
  vault named `Personal`, plus every vault shared with you. Multiple owned vaults
  would need the `EncryptedMapsControlPlaneCanister` variant and app-owned value
  endpoints.
- No browser extension, autofill, TOTP, attachments, or trash/undo.
- Deleting an item is immediate and permanent.
- Sharing is by principal — you paste the other person's principal (the **My
  principal** button copies yours).
