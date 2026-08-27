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

icp network start -d          # this project uses gateway port 0, so it can run
                              # alongside other icp-cli projects
icp deploy                    # builds the canister and the frontend, then syncs

icp network status --json | jq -r '.gateway_url'   # the port changes each start
```

`icp deploy` prints the frontend URL, e.g. `http://frontend.local.localhost:52368/`.

Verify the crypto and access-control path end to end:

```bash
npm run smoke-test            # 8 checks against the deployed local canister
```

For UI work, `npm run dev` serves the app on Vite with the `ic_env` cookie faked
from the live local network (canister IDs and root key read via `icp network status`),
so sign-in and canister calls work the same as in the deployed build.

### Mainnet

```bash
icp identity default <your-identity>   # never deploy to mainnet as anonymous
icp deploy -e ic
```

Before that, change `VETKD_KEY_NAME` in `icp.yaml` from `test_key_1` to `key_1`.

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
