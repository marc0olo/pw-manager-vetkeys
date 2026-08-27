# vetVault

A small password manager on the Internet Computer, modelled on 1Password's shape:
vaults on the left, a searchable item list in the middle, item details on the right.

Secrets are encrypted **in the browser** with [vetKeys](https://internetcomputer.org/docs/building-apps/network-features/vetkeys/introduction)
`EncryptedMaps`. The canister only ever holds ciphertext, and there is no master
password — the vault key is derived for your Internet Identity principal.

## Features

- **Internet Identity sign-in.** No account, no master password. 8-hour session.
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
src/frontend/lib/auth.ts   Internet Identity
src/frontend/components/   Sidebar, item list, detail, editor, share dialog
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

Derived key material is kept **in memory only**. Reloading the tab genuinely locks
the vault. The persistent `IndexedDbDerivedKeyMaterialCache` is deliberately not
used: it would leave a usable decryption capability on disk for any same-origin code.

## Run it

```bash
npm install

icp network start -d          # gateway pinned to port 8100 (see below)
icp deploy                    # builds the canister and the frontend, then syncs
```

`icp deploy` prints the frontend URL: `http://frontend.local.localhost:8100/`.

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

The vault locks three ways, all through `lock(reason)` in `App.tsx`, always in the
same order: drop the derived key material, then the delegation, then all vault
state. The lock screen says which happened.

| Trigger | When |
|---|---|
| `manual` | the **Lock vault** button |
| `idle` | 5 minutes without interaction |
| `expired` | the 8-hour delegation runs out |

Because key material is memory-only, reloading the tab also locks the vault.

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
