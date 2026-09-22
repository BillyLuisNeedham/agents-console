#!/usr/bin/env bash
# Link every skill under skills/ into ~/.claude/skills so Claude Code finds it
# by name, and put the `agent-console` shim on PATH so a pool can be booted
# without an agent at all (issue #121). Idempotent: re-run after adding a skill
# directory. Run it from the main checkout, not a worktree: the links point at
# the directory it runs in.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
target="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
mkdir -p "$target"
for dir in "$here"/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/SKILL.md" ] || continue
  ln -sfn "${dir%/}" "$target/$name"
  echo "linked $name -> ${dir%/}"
done

bindir="${AGENT_CONSOLE_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bindir"
ln -sfn "$repo/bin/agent-console" "$bindir/agent-console"
echo "linked agent-console -> $repo/bin/agent-console ($bindir)"
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "warning: $bindir is not on PATH; add it to run agent-console by name" >&2 ;;
esac
