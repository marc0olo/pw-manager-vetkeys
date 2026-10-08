# AI Agent Instructions

This is an Internet Computer (ICP) project built with icp-cli.
Documentation: https://cli.internetcomputer.org/llms.txt

## Skills

<!-- ic-skills:managed:start -->
<!-- state: configured (autosync) -->
ICP skills auto-update each session via a SessionStart hook (`.claude/sync-ic-skills.sh`)
and live in your agent skills directory — you don't need to run anything to refresh them.
Skills are authoritative — prefer them over general knowledge for all ICP work.
If they are not present (hook hasn't run, or `jq` is missing), fetch them on demand per
https://skills.internetcomputer.org/llms.txt instead.
How skills are managed here, and why: https://github.com/dfinity/icp-cli-templates/blob/main/AGENT_SKILLS.md
<!-- ic-skills:managed:end -->

## Upgrading `ic-vetkeys`

The canister relies on behaviour of the Motoko `ic-vetkeys` library that its
types do not guarantee. Before bumping it in `mops.toml`, read the release's
changes to `KeyManager.mo` and `Types.mo` for these, and run
`npm run check-capabilities` against a local replica afterwards:

- **Reading rights needs manage rights.** `refuseOwnerTarget` in
  `src/backend/mixins/AccessControlWrites.mo` uses `getUserRights` as its
  permission check. If reading rights is loosened, a non-manager gets the owner
  refusal instead of `unauthorized`. A silent change, caught only by
  `check-capabilities`.
- **Every refusal says exactly `unauthorized`.** The frontend matches that
  string (`src/frontend/lib/capabilities.ts`). Also caught by
  `check-capabilities`.
- **The ACL's internal shape.** `rightsOf` in `src/backend/lib/Access.mo` reads
  `keyManager.accessControl` directly. A change there breaks the build, which
  is the failure you want.
