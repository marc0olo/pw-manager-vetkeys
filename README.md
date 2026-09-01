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
- **Live updates.** The vault list is re-read every 15 s, so a newly shared vault,
  a new item or a revocation appears without a reload. Listing needs no key, so
  polling costs no derivations — and it carries no ciphertext either: the
  canister returns one digest per vault instead of its contents, which is ~89 %
  less on the wire and no hashing in the browser. A manual check sits beside the
  app name.
- **Password generator** with length, digits and symbols, plus a strength read-out.
- **Reveal / copy.** Passwords are masked, auto-hide after 30s, and copying one
  clears the clipboard after 45s (only if it still holds that value).
- **Vault sharing** at three levels, and collaborators can actually use them:
  someone granted read/write edits items in your vault, and read/write/manage
  can re-share it. The vault key is re-encrypted for the grantee, so no secret
  changes hands. The sidebar and the pane header both show how many people a
  vault is shared with.
  - Read/write is **destructive**: the canister guards "delete every item" with
    the same write check, so there is no separate delete right. The share dialog
    says so rather than calling it "can edit items".
  - Your own rights on a vault shared *with* you are not disclosed by the
    canister ([dfinity/vetkeys#438]), so the app offers the controls and adapts
    if a write is refused, rather than guessing read-only from silence.
- **Empty vault** removes every item at once, behind a typed confirmation. The
  vault and its sharing survive; the items do not.
- **Rename a vault** you own. A vault *is* `(owner, name)` and its vetKey
  derives from that pair, so the map never moves: the backend stores a display
  name beside it and a rename is one write — nothing re-encrypted, nobody
  re-invited, collaborators see the change immediately.
  - The original name stays in the clear and cannot be changed, which the
    dialog says plainly. Renaming is a label, not a way to hide what a vault
    was called.
- **Lock** discards the derived key material. The sidebar shows both deadlines
  that end a session — the sliding idle lock and the fixed sign-in expiry — with
  whichever comes first highlighted.

## Architecture

```
src/backend/main.mo        The whole backend: EncryptedMaps state + the canister mixin
src/frontend/lib/vault.ts  Encrypt/decrypt and access control over EncryptedMaps
src/frontend/lib/items.ts  The item model and its JSON encoding
src/frontend/lib/reconcile.ts  What the UI does when the canister changes underneath
src/frontend/lib/auth.ts   Internet Identity, and the load-time session gate
src/frontend/lib/session.ts  Idle timeout, activity mark, cross-tab lock, key purge
src/frontend/lib/lock.ts     The lock sequence: ordering and failure safety
src/frontend/lib/capabilities.ts  What we may do on a vault, and learning from a refusal
src/frontend/lib/backend.ts  This app's own endpoints, over the generated binding
src/bindings/              Generated from the canister's Candid — `npm run bindings`

Bindings are generated but **committed**, so a clone can typecheck, test and run
the replica scripts without a Motoko toolchain — without them `tsc` reports 10
errors and 95 of 171 tests fail to load. The trade is that they can go stale:
**after changing `src/backend/main.mo`, run `npm run bindings`**, and
`npm run check-bindings` fails if you forget. Note that additive drift is the
quiet kind — Candid ignores record fields it does not know, so a new field goes
unnoticed, while a removed or retyped one fails loudly.
src/frontend/lib/poll.ts     What a poll changes, as one patch
src/frontend/components/   Sidebar, item list, detail, editor, share dialog, session status
src/frontend/lib/__tests__/  Unit tests: session lifetime, load-time gate, lock sequence,
                           locked state, poll reconciliation, capabilities, vault names
src/frontend/__tests__/    Component tests: the transitions — lock, sign-in, refusal, revocation
scripts/smoke-test.mjs     End-to-end check against a running local replica
scripts/check-poll-cost.mjs  Asserts a poll derives no keys and opening one vault derives one
scripts/check-capabilities.mjs  Verifies the access-level table the share dialog states
scripts/check-vault-names.mjs  Verifies renaming moves no map and derives no key
scripts/check-bindings.mjs  Fails if the committed Candid binding is stale
```

The backend adds two endpoints of its own — `set_vault_name` and
`get_vault_names` — beside the mixin. Additive only: every endpoint the
`@icp-sdk/vetkeys` client calls is still the mixin's, so the stock client keeps
working and only our two need a hand-written binding.

`include EncryptedMapsCanister(state)` contributes every
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

Both live in `SESSION_POLICY` in `src/frontend/lib/session.ts`.

The delegation is **not** canister-scoped. Internet Identity does not issue
scoped delegations — it ignores a `targets` request and returns an unscoped
chain, which the client then rejects, so sign-in fails outright. Little is lost:
II derives a principal per *origin*, so this principal exists only for this app
and holds nothing on any other canister, and the IC is reverse-gas, so a leaked
delegation cannot spend the user's cycles elsewhere.

Why a deadline checked on load rather than clearing on close: there is no
reliable "the app was closed" hook. `pagehide`/`beforeunload` do not run on a
crash, force-quit or OS kill — so anything relying on them leaves credentials
behind exactly when it matters — and they *also* fire on an ordinary reload, so
clearing there would demand a fresh passkey on every refresh. A stored deadline
needs no cooperation from the shutdown path: whatever killed the app, the next
load refuses and purges. A missing mark counts as expired, so it fails closed.

#### Why key material is cached at all

Opening a vault costs one `vetkd_derive_key` call — about 0.026 XDR on `key_1`,
paid by the canister. Two things keep that bounded:

- **Vaults are opened lazily.** Listing costs **no derivations at all**; a key is
  derived only for the vault you actually open. A user with 1 owned + 25 shared
  vaults pays 1 derivation instead of 26.
- **The listing carries no ciphertext.** `get_vault_summaries` returns each
  vault's owner, name, access control and item *keys* — plus one SHA-256 digest
  standing in for its contents, so the client can still tell whether a vault
  changed without downloading it. The values are the bulk, and the poll never
  needed them. Both properties are asserted against a live replica by
  `npm run check-poll-cost`.
- **The derived key is cached**, so reopening a vault, and any reload inside the
  session window, costs nothing.

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

Because both halves read the clock, both also guard against it being wound
**backwards**: a jump of more than 30 s back makes a stale session look recent, so
it locks or refuses rather than being waited out. Forward jumps need no guard —
they only make the measured age larger, which already locks sooner. Smaller skew
(NTP, resume from sleep) is tolerated so it cannot log anyone out on its own.

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
  empty vault cannot be persisted without extra backend metadata
  ([dfinity/vetkeys#439]). You get one vault named `Personal`, plus every vault
  shared with you. Multiple owned vaults would need that fixed upstream, or the
  `EncryptedMapsControlPlaneCanister` variant and app-owned value endpoints.
- No browser extension, autofill, TOTP, attachments, or trash/undo.
- Deleting an item — or emptying a vault — is immediate and permanent.
- Sharing is by principal — you paste the other person's principal (the **My
  principal** button copies yours).

Some of the above, and other behaviour described earlier, is shaped by open upstream issues — all filed from this project:

| Upstream | What it costs us |
|---|---|
| [dfinity/vetkeys#437] | A `ReadWriteManage` grantee can get the owner's vault listed twice, and ACL writes targeting the owner are accepted. The client de-duplicates. |
| [dfinity/vetkeys#438] | A grantee cannot read their own rights, so the UI offers capabilities and adapts to a refusal instead of asking. |
| [dfinity/vetkeys#439] | An owned vault cannot exist while empty, so the client synthesises a placeholder for it. |
| [dfinity/vetkeys#440] | The derived-key cache holds an IndexedDB connection that never yields, so its store cannot be deleted — only cleared. The purge skips it. |

[dfinity/vetkeys#437]: https://github.com/dfinity/vetkeys/issues/437
[dfinity/vetkeys#438]: https://github.com/dfinity/vetkeys/issues/438
[dfinity/vetkeys#439]: https://github.com/dfinity/vetkeys/issues/439
[dfinity/vetkeys#440]: https://github.com/dfinity/vetkeys/issues/440
