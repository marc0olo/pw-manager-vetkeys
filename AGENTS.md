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
