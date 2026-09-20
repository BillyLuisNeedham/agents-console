#!/usr/bin/env bash
# Link every skill under skills/ into ~/.claude/skills so Claude Code finds it
# by name. Idempotent: re-run after adding a skill directory. Run it from the
# main checkout, not a worktree: the links point at the directory it runs in.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
mkdir -p "$target"
for dir in "$here"/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/SKILL.md" ] || continue
  ln -sfn "${dir%/}" "$target/$name"
  echo "linked $name -> ${dir%/}"
done
