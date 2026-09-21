# Conventions

Specs live in git history, not on main. Before opening a PR from a branch that added files under `docs/specs/`, delete those files in a final commit on the branch.

Skills live under `skills/`, one directory per skill, and reach Claude Code only through a symlink in `~/.claude/skills`. A new skill is a new directory plus `skills/link.sh`, which links every one of them idempotently.
