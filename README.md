# vetVault

A small password manager on the Internet Computer, modelled on 1Password's shape:
vaults on the left, a searchable item list in the middle, item details on the right.

Secrets are encrypted **in the browser** with [vetKeys](https://internetcomputer.org/docs/building-apps/network-features/vetkeys/introduction)
`EncryptedMaps`. The canister only ever holds ciphertext, and there is no master
password — the vault key is derived for your Internet Identity principal.

## Features

- **Internet Identity sign-in.** No account, no master password. Auto-locks
  after 5 minutes idle, whether the app is open or closed.
- **Items**: title, username, password, website, notes — create, edit, delete.
  **Search** across every field except the password.
- **Password generator** with length, digits and symbols, and a strength
  read-out.
- **Reveal / copy.** Passwords are masked, auto-hide after 30 s, and copying one
  clears the clipboard after 45 s — only if it still holds that value.
- **Live updates.** The vault list is re-read every 15 s and on returning to the
  tab, so a newly shared vault, a new item or a revocation appears without a
  reload; a **check-for-changes** button only cuts the wait. Listing needs no
  key, so polling costs no derivations, and it carries no ciphertext either —
  the canister returns one digest per vault instead of its contents, ~89 % less
  on the wire.
- **Vault sharing** at three levels, and collaborators can use them: read/write
  edits items, read/write/manage can re-share. The vault key is re-encrypted for
  the grantee, so no secret changes hands.
  - Read/write is **destructive** — the canister guards "delete every item" with
    the same write check, so there is no separate delete right, and the share
    dialog says so.
  - **One entry per person, not one per grant.** Sharing with someone who
    already has access replaces their level rather than adding a row, so
    promoting and demoting are the same operation, effective immediately with no
    re-derivation. A demotion is not a revocation: writes are refused at once
    while reads keep working.
  - The library will not tell a grantee their own rights
    ([dfinity/vetkeys#438]), so this backend does — it reads the access list it
    already holds and reports what *you* may do. Controls match permissions from
    the first render, with the adapt-on-refusal path kept as a fallback, since
    the canister is still the only authority.
- **You can see which vaults changed while you were away** — a dot on the
  sidebar row, and a dot per item once you open that vault, saying whether it
  was added or edited. Your own writes are never marked, a vault seen for the
  first time is recorded rather than flagged, and the marks survive a lock,
  because "since I last looked" is meaningless if locking resets it.
- **You do not need a vault of your own.** With none, the app shows your
  principal and offers to copy it, so you can be shared with instead.
- **Create, rename and delete vaults.** As many as you like, but **no two of
  yours may show the same name** — the empty-vault and delete-vault
  confirmations arm on the typed label, so duplicates would have you confirm a
  name rather than a vault. Per owner, exact after trimming, and case-sensitive.
  - A vault **is** `(owner, mapName)` and its key derives from that pair, so a
    new vault gets a *random* map name with a display name beside it. The map
    name can never change, which is why renaming only sets the label — the
    original stays in the clear, and the dialog says so.
  - Deleting takes the contents, every version of them, the trash and the
    sharing in one call. It does not destroy the key, which is derived rather
    than stored.
- **Empty vault** removes every item at once behind a typed confirmation, and
  the vault and its sharing survive. Separate from Delete because revoking needs
  manage rights, so a `ReadWrite` collaborator can only empty.
- **Trash.** A deleted item — or a whole emptied vault — is recoverable for
  90 days, decrypting under exactly the key material it always had. The dialog
  shows real titles, decrypted in the browser under the cached key.
  - **Every version is kept**, and shown: how many an item has, newest first,
    with the password as it was, plus who recorded each version and when. Any
    can be restored, and restoring keeps the value it replaces. Trash, version
    history and the audit trail are one append-only log — a deletion is a
    version with nothing after it.
  - **"Updated" is the canister's timestamp**, not the item's own `updatedAt`,
    which lives inside the encrypted payload and is the writer's to choose.
  - **Who sees it:** the log belongs to the vault, so everyone who can read the
    vault reads it, including members added later.
  - **A writer cannot destroy anything.** Editing and deleting only append.
    Removing is the owner's — **Empty trash** makes deletions unrecoverable, and
    dropping a secret's history clears the ciphertext while keeping the events,
    so pruning cannot launder the record. Time is the only other remover.
- **Lock** discards the derived key material. The sidebar shows both deadlines
  that end a session — the sliding idle lock and the fixed sign-in expiry — with
  whichever comes first highlighted.

## Architecture

```
src/backend/main.mo        Composition root: state, and the includes. No endpoints
src/backend/types.mo       Every type the canister exposes, plus the state records
src/backend/mixins/        This application's own endpoint groups — value writes,
                           access-control writes, vaults, history, trash, health
src/backend/lib/Access.mo  Who may read a vault, and what a caller may do in it
src/backend/lib/Cycles.mo  The balance thresholds and the watchdog every write runs
src/backend/lib/Recording.mo  Appending events, and the liveness a write needs
src/backend/lib/Vaults.mo  The owned-vault registry and the display-name rules
src/backend/lib/Digest.mo  The vault content digest — pure, and unit-tested
src/backend/lib/History.mo Every version of every secret — pure, and unit-tested
src/backend/lib/vetkeys/  The four endpoint groups dfinity/vetkeys#443 proposes
                          that this app inherits unchanged (#58)
test/Digest.test.mo        Motoko tests: `mops test`, no replica needed
test/History.test.mo       Append-only, per-secret expiry, liveness, pruning
src/frontend/lib/vault.ts  Encrypt/decrypt and access control over EncryptedMaps
src/frontend/lib/items.ts  The item model and its JSON encoding
src/frontend/lib/reconcile.ts  What the UI does when the canister changes underneath
src/frontend/lib/poll.ts     What a poll changes, as one patch
src/frontend/lib/seen.ts     Which vaults changed since you last looked
src/frontend/lib/auth.ts   Internet Identity, and the load-time session gate
src/frontend/lib/session.ts  Idle timeout, activity mark, cross-tab lock, key purge
src/frontend/lib/lock.ts     The lock sequence: ordering and failure safety
src/frontend/lib/capabilities.ts  What we may do on a vault, and learning from a refusal
src/frontend/lib/health.ts   Why a key derivation failed, in words a user can act on
src/frontend/lib/errors.ts   How any other failure reads to a user, classified not pasted
src/frontend/lib/backend.ts  This app's own endpoints, over the generated binding
src/bindings/declarations  Generated from the canister's Candid — `npm run bindings`
src/bindings/backend.most  The backend's stable signature, so stable-type changes show in a diff
src/frontend/components/   Sidebar, item list, detail, editor, share dialog, session status
src/frontend/lib/__tests__/  Unit tests: session lifetime, load-time gate, lock sequence,
                           locked state, poll reconciliation, capabilities, vault names
src/frontend/__tests__/    Component tests: the transitions — lock, sign-in, refusal, revocation
scripts/smoke-test.mjs     End-to-end check against a running local replica
scripts/check-poll-cost.mjs  Asserts a poll derives no keys and carries no ciphertext
scripts/check-capabilities.mjs  Verifies the access-level table the share dialog states
scripts/check-vault-names.mjs  Verifies renaming moves no map and derives no key
scripts/check-history.mjs  Verifies a writer can add versions but destroy none
scripts/check-owned-vaults.mjs  Verifies creation is a vault's only origin, and that it survives being emptied
scripts/check-bindings.mjs  Fails if the committed binding or stable signature is stale
scripts/check-ii-metadata.mjs  Validates the II app-metadata document
scripts/check-comments.mjs  Fails if a doc block is stranded, or if main.mo
                           documents an endpoint it does not have
scripts/lib/cycles.mjs     What a replica check cost, and how much headroom is left
```

The backend no longer includes a library mixin. It builds one `EncryptedMaps`
instance and passes it to the endpoint groups — the split proposed in
dfinity/vetkeys#443, implemented locally under `src/backend/lib/vetkeys/` to
test those boundaries before the library commits to them (#58). Four of the
library's six behave exactly as its mixin did. Two are ours: the value
**writes**, because owning them is the only way to record a version of a secret
as it is replaced, and the **access-control writes**, because a vault must exist
before it can be shared and the library has no notion of a vault existing.

Two constraints the proposal did not anticipate, both found by building it:
groups take the constructed instance rather than the state, because sibling
mixins cannot both declare `encryptedMaps` (M0051 rejects a duplicate binding as
readily as a duplicate type); and the shared types are referenced through
`lib/vetkeys/Types.mo` rather than aliased locally, because a local alias makes
the generated binding churn its `Result_N` names. The signatures `@icp-sdk/vetkeys`' client calls are
kept exactly, so the stock client still works; everything beyond them is
additive and needs a binding of ours.

That binding is **generated** from the canister's Candid, not written by hand.
It is also **committed**, so a clone can typecheck, test and run the replica
checks without a Motoko toolchain — without it `tsc` fails and most of the test
suite cannot even load. The trade is that committed generated code can go stale,
so **run `npm run bindings` after changing `src/backend/main.mo`**;
`npm run check-bindings` fails if you forget, and CI runs it on every pull
request. Additive drift is the quiet kind: Candid ignores record fields it does
not know, so a new field goes unnoticed, while a removed or retyped one fails
loudly.

Committed beside it is `backend.most`, the canister's **stable signature**.
Nothing reads it at runtime — it is there so that changing the type of a stable
variable appears in the diff, which is what tells a reviewer whether an upgrade
still carries the data. Reading a Candid failure as a state incompatibility has
produced a wrong deploy instruction twice here, in opposite directions; see the
note under **Run it locally**, and #42.

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
| Changed-since-last-look marks | `localStorage`, per principal | survive a lock; swept for other principals on sign-in |

A mark is `<owner principal>/<map id>` → `<digest>:<digest>`. The **display name
is not written**, so nothing on disk says `Divorce lawyer`, and map ids are
random for vaults this app creates. What the keys *do* carry is the **owner
principals of vaults shared with you**, and how many vaults each shares — the
only place this app records other people's identifiers locally. Item-level marks
add random item ids and write times under their own key. Signing in sweeps every
other principal's marks, for the same reason the key-store purge deletes stores
left by principals no longer recorded.

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
paid by the canister. Three things keep that bounded:

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
nvm use                       # or fnm use — reads .nvmrc
npm install

icp network start -d          # gateway pinned to port 8100 (see below)
icp deploy                    # builds the canister and the frontend, then syncs
```

`icp deploy` prints the frontend URL: `http://frontend.local.localhost:8100/`.

`.nvmrc` names the Node line CI runs and the Motoko dev image ships, so
`nvm use` puts local development on the same one. Skipping it mostly works —
`engines` in `package.json` states a lower floor and the code holds to it — but
a Node your bundled `npm` does not support prints a warning on every command,
and a warning you always see is a warning you stop reading.

> **`Candid compatibility check failed` is not a reason to reinstall.** Two
> different things block a deploy and only one loses data:
>
> - **The Candid interface is no longer a subtype** — a method removed, renamed
>   or retyped. That breaks *clients*, not stored state.
>   `icp deploy --mode upgrade -y` accepts the break and keeps every secret.
> - **The stable signature is incompatible** — a stable variable's type changed
>   in a way an upgrade cannot carry. Only this needs a migration, or
>   `icp deploy --mode reinstall -y`, which **drops every stored secret**.
>
> They look identical from the error, so check rather than guess:
>
> ```bash
> "$(mops toolchain bin moc)" --stable-compatible \
>   src/bindings/backend.most .mops/.build/backend.most
> # exit 0 means an upgrade carries the data
> ```
>
> Use `mops toolchain bin moc` — there is no `moc` on `PATH`, and the cache's
> lexically last version is 1.9.0 rather than the pinned 1.14.0. Both files must
> come from `icp build`, since the generated type names depend on how the file
> was produced.
>
> A reinstall is also sometimes *wanted* where an upgrade would work — to clear
> state a new invariant assumes away, which is free pre-production. That is a
> different question from whether an upgrade is *possible*, and conflating the
> two has produced a wrong deploy instruction here twice, in both directions
> (#42).

```bash
npm test                      # unit tests and component transitions (no replica needed)
npm run test:motoko           # backend unit tests (no replica needed)
npm run check-bindings        # the committed Candid binding still matches the canister
npm run check-ii-metadata     # validates the II app-metadata document
npm run check-comments        # no stranded doc block, and no `///` in the composition root

# these need a running replica and a deployed canister
npm run smoke-test            # crypto + access control end to end
npm run check-capabilities    # the access-level table, and what changing someone's access does
npm run check-poll-cost       # a poll derives no keys and carries no ciphertext
npm run check-vault-names     # renaming moves no map and derives no key
npm run check-history         # a writer can add versions but destroy none
npm run check-owned-vaults    # creation is a vault's only origin, and it survives being emptied
```

The first five run in CI on every pull request; the replica ones do not, so
run them locally before opening one.

**Running the replica checks is what drains the canister.** Each ends with what
it cost and how much headroom is left, measured rather than assumed:

```
this run cost 20.2 B; 11.31 T left, about 559 more run(s)
```

A `vetkd_derive_key` on `test_key_1` reserves 10 B cycles and the checks derive
heavily, so a round of all six costs **roughly half a trillion**, and a
canister topped up to 10 T affords something like twenty. Mutation testing,
which redeploys and re-runs them per mutant, is what actually empties one.
Exact figures are not listed here because each check prints its own, measured
on the run you just did — they drift every time a check gains a case.

Top up with:

```bash
icp canister top-up backend --amount 10000000000000
```

> **`IC0406`** means the canister's *outbound* call failed, not why. Running
> out of cycles is the cause you will hit here; a vetKD key missing from the
> subnet, a freezing threshold reserving the balance, and queue pressure look
> identical from outside — the reject text even varies (`could not perform
> remote call`, `could not perform self call`), which is why the code is what
> the app matches on.
>
> Measured on a local replica, on `test_key_1`: derivation still worked at
> **482 B** and failed at **472 B**. The 10 B gap between those is exactly what
> that key reserves; the *level* is a different question, and mostly not the
> fee. At the idle burn recorded then, the freezing threshold accounts for
> roughly 48 B of it, and the remainder is unattributed. The threshold was also
> being changed to provoke `IC0406` while this was measured.
>
> So treat 472 B as a local observation, not a formula: it does not scale with
> the fee, and it does not transfer to mainnet, where both the freezing reserve
> and the key's price differ. The watchdog's threshold is counted in rounds of
> the checks above that cliff rather than as a multiple of the fee, for the
> same reason.
>
> Worth recognising because in this app it presents as data loss — unlocking
> fails, so the secrets look gone, when nothing is gone and a top-up restores
> everything.
>
> The canister tries not to let you reach it: every write checks its own
> balance and logs a warning while it still works, and the replica checks
> surface that warning. Canister logs are controller-only
> (`icp canister logs backend`).
>
> If a user does reach it, the app asks `get_service_health` and leads with
> the answer to the only question they have — the passwords are still there,
> encrypted and unchanged — then names the cause if the canister knows one. The
> reject goes to the console rather than the banner: a method name and an error
> code under a heading about a canister is what made this read as data loss in
> the first place. That answer is a state and never a balance, and only callers
> who already have a vault get one — by the time a derive can fail for you, you
> have one.

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

> **The derive fee follows the key, not your canister.** It is set by the subnet
> the vetKey lives on, so `key_1` costs
> [26_153_846_153 cycles](https://docs.internetcomputer.org/references/cycle-costs/#vetkeys)
> on the 34-node fiduciary subnet wherever you deploy, against 10_000_000_000
> for `test_key_1` on its 13-node subnet. Switching keys multiplies the
> per-derivation cost by about 2.6, so the thresholds in `lib/Cycles.mo` —
> measured locally — are a local calibration and not a mainnet one.

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

- No browser extension, autofill, TOTP, or attachments.
- Expired versions are not purged on a schedule — there is no timer, because
  Motoko timers do not survive an upgrade. A deleted secret and its history are
  *unreachable* 90 days on, always, since the read paths filter by age. The
  bytes are reclaimed on the next write to **that vault**, because deciding
  what has expired needs to know which secrets are still live and that is the
  encrypted-maps state. So a vault nobody writes to again keeps expired
  ciphertext on disk. Unreachable, but stored.
- Sharing is by principal — you paste the other person's principal (the **My
  principal** button copies yours).

Some of the above, and other behaviour described earlier, is shaped by open upstream issues — all filed from this project:

State checked **2026-09-11**. Treat the column as of that date rather than as
current. Three habits this table earned the hard way:

- Verify a fix against the **shipped bundle** rather than the issue, since an
  issue closes when a fix merges and not when it ships.
- Check **who** closed an issue before assuming a maintainer did.
- **Never put a closing keyword before an issue reference in a PR title or
  body.** GitHub's parser matches `close`/`closes`/`closed`/`fixes`/`resolves`
  ahead of a reference regardless of grammar — a negation and a past-tense
  narrative both fire it. A full URL is *not* an escape; the parser accepts
  that form too. The only safe shape is no keyword before the reference:
  reword, or put the reference first.

| Upstream | State | What it costs us |
|---|---|---|
| [dfinity/vetkeys#437] | open | A `ReadWriteManage` grantee can get the owner's vault listed twice, and ACL writes targeting the owner are accepted. The client de-duplicates. |
| [dfinity/vetkeys#438] | reopened | A grantee cannot read their own rights, so the backend reads the access list itself. **We closed it by accident twice**, both times from prose GitHub's parser read as a directive: #35's body said "this does not close dfinity/vetkeys#438", and #72's *title* said "who closed #438" — a PR whose purpose was documenting the first one. Reopened; the behaviour is unchanged at 0.6.0. |
| [dfinity/vetkeys#439] | open | An owned vault cannot exist while empty, so the canister keeps its own registry of owned vaults and unions it with the library's listing. |
| [dfinity/vetkeys#440] | fixed, unreleased | The derived-key cache held an IndexedDB connection that never yielded. Fixed upstream in #441, absent from `@icp-sdk/vetkeys` 0.7.0, so the purge still skips a store the live client holds. |
| [dfinity/vetkeys#442] | open | The Motoko library hardcodes the vetKD derive fee instead of querying `ic0.cost_vetkd_derive_key`. |
| [dfinity/vetkeys#443] | open | Motoko: `EncryptedMapsCanister` is the unit, so owning one endpoint means hand-writing seven. Asks for the composite to be a composition of includable parts. This app runs that split locally and owns two of the six groups. |
| [dfinity/vetkeys#445] | open | The committed `.did` files are never checked against the canisters they describe, so the artifact the frontend declarations are generated from can drift silently. |
| [dfinity/vetkeys#446] | open | Meta: the reports filed from this project are three clusters, not ten defects — three of them are one four-line function. Carries the sequencing constraints. |
| [dfinity/vetkeys#447] | open | Rust: the macro generates `#[init]` and `#[post_upgrade]`, and a canister may have only one of each — so an adopter with its own state has nowhere to put its lifecycle. Split out of #443. |
| [dfinity/vetkeys#444] | open | Sharing a map that was never created lists it for the grantee. The canister refuses the share, which only an adopter owning that endpoint can do. |

[dfinity/vetkeys#437]: https://github.com/dfinity/vetkeys/issues/437
[dfinity/vetkeys#438]: https://github.com/dfinity/vetkeys/issues/438
[dfinity/vetkeys#439]: https://github.com/dfinity/vetkeys/issues/439
[dfinity/vetkeys#440]: https://github.com/dfinity/vetkeys/issues/440
[dfinity/vetkeys#442]: https://github.com/dfinity/vetkeys/issues/442
[dfinity/vetkeys#443]: https://github.com/dfinity/vetkeys/issues/443
[dfinity/vetkeys#444]: https://github.com/dfinity/vetkeys/issues/444
[dfinity/vetkeys#445]: https://github.com/dfinity/vetkeys/issues/445
[dfinity/vetkeys#446]: https://github.com/dfinity/vetkeys/issues/446
[dfinity/vetkeys#447]: https://github.com/dfinity/vetkeys/issues/447
