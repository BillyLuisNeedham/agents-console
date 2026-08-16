#!/usr/bin/env bash
#
# Issue runner.
#
# Works a queue of Issues. One orchestrator per Issue, then it exits. The next
# orchestrator starts fresh. State lives on line 1 of each Issue file, so an
# interrupted run picks up where it stopped.
#
# Each Issue runs on a harness: claude, opencode, or cursor's agent CLI. The
# default harness and model live in ~/.issue-runner, read every time the
# runner starts. A per-Issue override lives in assign_for below the marker.
#
#   ./run.sh              work the queue until it halts
#   ./run.sh status       print the board, change nothing
#   ./run.sh next         print which Issue would run next
#   ./run.sh reset NN     put Issue NN back to ready
#
# Exit codes:
#   0  the queue finished, or nothing is runnable
#   1  a preflight refusal, such as a dirty worktree
#   2  an Issue reached a checkpoint and needs you
#   3  an Issue ended without setting its own status
#
# Environment overrides:
#   RUNNER_MAX_ISSUES   safety stop           (default: set below the marker)
#
# Everything above the CONFIG marker is the engine. It is identical in every
# runner /my-issue-runner generates, and that sameness is the point: leave it
# alone. To pick up a newer engine, run the skill again on this directory. It
# replaces above the marker and leaves your config below it untouched.
#
# engine-version: 2.0.0
#
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RUNNER_DEFAULTS="$HOME/.issue-runner"

# ---------------------------------------------------------------- helpers

# macOS sed and GNU sed disagree about -i. Normalise.
sedi() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }

field()   { grep -m1 -oE "$2=[^ ]+" "$1" | head -1 | cut -d= -f2-; }
status()  { field "$1" status; }
blocks()  { field "$1" "blocked-by"; }
file_of() { ls "$ISSUES_DIR"/"$1"-*.md 2>/dev/null | head -1; }
id_of()   { basename "$1" | cut -d- -f1; }

set_status() { sedi "1s/status=[a-z-]*/status=$2/" "$1"; }

# The dotfile is read on every start, so editing it re-aims every queue at
# once. A missing file is not an error here: preflight reports it per Issue.
default_harness() { [ -f "$RUNNER_DEFAULTS" ] && field "$RUNNER_DEFAULTS" harness; }
default_model()   { [ -f "$RUNNER_DEFAULTS" ] && field "$RUNNER_DEFAULTS" model; }

# A non-empty line from assign_for wins. Whatever it leaves blank comes from
# ~/.issue-runner. The result is always two words: "harness model".
assignment_for() {
  local a h m
  a="$(assign_for "$1")"
  h="$(echo "$a" | cut -d' ' -f1)"
  m="$(echo "$a" | cut -d' ' -f2)"
  [ -z "$h" ] && h="$(default_harness)"
  [ -z "$m" ] && m="$(default_model)"
  echo "$h $m"
}

# Each harness's binary on PATH.
bin_of() {
  case "$1" in
    claude)   echo "claude" ;;
    opencode) echo "opencode" ;;
    cursor)   echo "agent" ;;
  esac
}

# Append a note to an Issue. A stop must always leave a trace in the Issue
# itself, not only in the log, because the Issue is what the next agent reads.
# Used when the agent cannot be relied on to have written its own brief.
note_issue() {
  local f="$1" log="$2" reason="$3"
  {
    printf '\n---\n\n## Brief, written by the runner\n\n'
    printf '%s\n\n' "$reason"
    printf -- '- Stopped: %s\n' "$(date '+%Y-%m-%d %H:%M')"
    printf -- '- Log: `%s`\n' "${log#"$REPO"/}"
    printf -- '- Working tree at the stop:\n\n'
    printf '```\n'
    git -C "$REPO" status --short 2>&1 | head -20
    printf '```\n'
    if [ -s "$log" ]; then
      printf '\nLast lines of the log:\n\n```\n'
      tail -n 25 "$log" 2>/dev/null
      printf '```\n'
    fi
    printf '\nNothing above is confirmed. Read the log before you trust any part of this Issue.\n'
  } >> "$f"
}

# An Issue is runnable when it is ready and every blocker is done.
runnable() {
  local f="$1" bb id bf
  [ "$(status "$f")" = "ready" ] || return 1
  bb="$(blocks "$f")"
  [ "$bb" = "none" ] && return 0
  for id in ${bb//,/ }; do
    bf="$(file_of "$id")"
    [ -n "$bf" ] || return 1
    [ "$(status "$bf")" = "done" ] || return 1
  done
  return 0
}

next_issue() {
  local f
  for f in "$ISSUES_DIR"/*.md; do
    if runnable "$f"; then echo "$f"; return 0; fi
  done
  return 1
}

board() {
  local f a
  printf '%-4s %-12s %-14s %-10s %s\n' ID STATUS BLOCKED-BY HARNESS ISSUE
  for f in "$ISSUES_DIR"/*.md; do
    a="$(assignment_for "$(id_of "$f")")"
    printf '%-4s %-12s %-14s %-10s %s\n' \
      "$(id_of "$f")" "$(status "$f")" "$(blocks "$f")" "${a%% *}" \
      "$(basename "$f" .md | cut -d- -f2-)"
  done
}

# The prompt every harness gets. It leads with the driver skill because the
# prompt is the only slot that counts as the human typing, the one slot that
# can reach a skill with disable-model-invocation. Everything else the agent
# needs is glued on behind it as plain words, because opencode and cursor have
# no flag for standing instructions, and one shape that works everywhere beats
# three shapes that each work somewhere.
build_prompt() {
  local rel="$1" drivers="$2" driver rest
  driver="${drivers%% *}"
  rest=""
  [ "$drivers" != "$driver" ] && rest="${drivers#* }"
  printf '/%s %s\n' "$driver" "$rel"
  printf '\nStanding instructions for this job:\n\n'
  cat "$DIR/AGENT.md"
  if [ -n "$rest" ]; then
    printf '\n---\n\nChain for this Issue. When the driver skill'\''s work is done, dispatch these subagents in this order, one at a time, and act on what each returns: %s.\n' "$rest"
  fi
  if [ -n "$ROSTER_TEXT" ]; then
    printf '\n---\n\nThe subagent roster for this job. Dispatch them by name. Each harness defines its own agents; on claude they come from the runner'\''s config, on opencode and cursor from your own setup:\n\n%s\n' "$ROSTER_TEXT"
  fi
}

# One case per harness, because each CLI is a different shape. What they
# share: the prompt leads with the driver skill, stdin is closed, and the
# harness runs with its fullest auto-approve mode, which an unattended run
# needs. There is no spend cap on any harness.
launch() {
  local harness="$1" model="$2" prompt="$3" driver="$4" rel="$5"
  case "$harness" in
    claude)
      ( cd "$REPO" && claude -p "$prompt" \
          --model "$model" \
          --permission-mode auto \
          --agents "$AGENTS" \
          --output-format text </dev/null ) ;;
    opencode)
      # opencode does not expand a slash command inside a run message, so the
      # driver goes through --command (bare name, no slash) and everything
      # else is the message, which becomes the command's arguments.
      ( cd "$REPO" && opencode run \
          --command "$driver" \
          "$rel

${prompt#*$'\n'}" \
          --model "$model" \
          --auto </dev/null ) ;;
    cursor)
      # UNPROVEN: written from Cursor's CLI docs, not yet run on a real queue.
      ( cd "$REPO" && agent -p "$prompt" \
          --model "$model" \
          --force --trust \
          --output-format text </dev/null ) ;;
    *)
      echo "STOP: unknown harness '$harness'" >&2
      return 1 ;;
  esac
}

# Tracked changes are refused: an unattended run would sweep them into a commit
# that claims to be an Issue's work. Untracked files only get a warning, because
# editor and tooling droppings are always there and refusing on them would make
# the runner unusable.
preflight() {
  [ -d "$ISSUES_DIR" ] || { echo "STOP: no Issue directory at $ISSUES_DIR" >&2; exit 1; }
  if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
    echo "STOP: the worktree has uncommitted changes to tracked files." >&2
    echo "      Commit or stash them, then start again." >&2
    git -C "$REPO" status --short --untracked-files=no >&2
    exit 1
  fi
  if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
    echo "runner: note, untracked files are present and an agent could commit them"
  fi

  # Every unfinished Issue must resolve to a harness and a model, the harness
  # must be installed, and the harness must be able to reach the first driver.
  # These are the failures that otherwise strand a queue hours in, so they
  # stop the run before it starts.
  local f id a h m bin d
  for f in "$ISSUES_DIR"/*.md; do
    [ "$(status "$f")" = "done" ] && continue
    id="$(id_of "$f")"
    a="$(assignment_for "$id")"
    h="$(echo "$a" | cut -d' ' -f1)"
    m="$(echo "$a" | cut -d' ' -f2)"
    if [ -z "$h" ] || [ -z "$m" ]; then
      echo "STOP: Issue $id has no harness or no model." >&2
      echo "      assign_for left it blank and $RUNNER_DEFAULTS does not fill the gap." >&2
      echo "      Write harness=.. and model=.. lines into $RUNNER_DEFAULTS, or set them in assign_for." >&2
      exit 1
    fi
    bin="$(bin_of "$h")"
    if [ -z "$bin" ]; then
      echo "STOP: Issue $id names unknown harness '$h'. Known: claude, opencode, cursor." >&2
      exit 1
    fi
    if ! command -v "$bin" >/dev/null; then
      echo "STOP: Issue $id runs on '$h', which needs '$bin' on PATH, and it is not there." >&2
      exit 1
    fi
    d="$(drivers_for "$id")"
    d="${d%% *}"
    case "$h" in
      opencode)
        [ -f "$HOME/.config/opencode/command/$d.md" ] || {
          echo "STOP: opencode cannot reach '/$d'. Its command palette only sees stubs in" >&2
          echo "      ~/.config/opencode/command/, and $d.md is not one of them." >&2
          echo "      Run scripts/link-opencode-commands.sh in your skills repo." >&2
          exit 1; } ;;
      cursor)
        [ -d "$HOME/.cursor/skills/$d" ] || {
          echo "STOP: cursor cannot reach skill '$d'. Cursor gets real copies in" >&2
          echo "      ~/.cursor/skills/, and $d is not one of them." >&2
          echo "      Run scripts/link-skills.sh in your skills repo." >&2
          exit 1; } ;;
    esac
  done

  mkdir -p "$LOGS"
}

# ---------------------------------------------------------------- the loop

main() {
  REPO="$(git -C "$DIR" rev-parse --show-toplevel)"
  LOGS="$DIR/runs"

  local max
  max="${RUNNER_MAX_ISSUES:-$MAX_ISSUES_DEFAULT}"

  case "${1:-run}" in
    status) board; exit 0 ;;
    next)
      if f="$(next_issue)"; then echo "$(id_of "$f")  $(basename "$f")";
      else echo "nothing runnable"; fi
      exit 0 ;;
    reset)
      f="$(file_of "${2:?usage: run.sh reset NN}")"
      [ -n "$f" ] || { echo "no Issue ${2}" >&2; exit 1; }
      set_status "$f" ready
      echo "Issue ${2} back to ready"; exit 0 ;;
  esac

  preflight

  if [ -f "$RUNNER_DEFAULTS" ]; then
    echo "runner: defaults harness=$(default_harness) model=$(default_model) from $RUNNER_DEFAULTS"
  else
    echo "runner: no $RUNNER_DEFAULTS; every Issue must name harness and model in assign_for"
  fi
  echo

  # An interrupted Issue must not be left at in-progress with nothing written.
  # The runner only starts Issues that are ready, so that Issue would be skipped
  # for ever and its part-done state would be invisible.
  CURRENT_ISSUE=""
  CURRENT_LOG=""
  trap on_interrupt INT TERM

  local worked=0 issue id rel log final drivers driver assignment harness model prompt
  while [ "$worked" -lt "$max" ]; do

    if ! issue="$(next_issue)"; then
      echo
      echo "No runnable Issue. Board:"
      board
      break
    fi

    id="$(id_of "$issue")"
    rel="${issue#"$REPO"/}"
    log="$LOGS/$id.log"

    drivers="$(drivers_for "$id")"
    driver="${drivers%% *}"

    assignment="$(assignment_for "$id")"
    harness="$(echo "$assignment" | cut -d' ' -f1)"
    model="$(echo "$assignment" | cut -d' ' -f2)"

    prompt="$(build_prompt "$rel" "$drivers")"

    echo "──────────────────────────────────────────────────────────────"
    echo "Issue $id  $(basename "$issue")"
    echo "harness  $harness   model $model"
    echo "drivers  $drivers"
    echo "log      $log"
    echo "──────────────────────────────────────────────────────────────"

    set_status "$issue" in-progress
    CURRENT_ISSUE="$issue"
    CURRENT_LOG="$log"

    launch "$harness" "$model" "$prompt" "$driver" "$rel" 2>&1 | tee "$log"

    final="$(status "$issue")"

    case "$final" in
      done)
        echo
        echo "✅ Issue $id done"
        worked=$((worked + 1))
        ;;
      checkpoint)
        # The agent should have written its own brief. If it set the status but
        # skipped the section, write one so the Issue is never a dead end.
        grep -q '^## Brief' "$issue" || note_issue "$issue" "$log" \
          "The agent stopped cleanly but did not write its own brief, so this note stands in for it."
        echo
        echo "🛑 Issue $id needs you. Stopping."
        echo
        sed -n '/^## Brief/,$p' "$issue"
        echo
        echo "When you have done your part:  ./run.sh reset $id"
        exit 2
        ;;
      *)
        set_status "$issue" checkpoint
        note_issue "$issue" "$log" \
          "The agent stopped without setting its own status, last seen as '$final'. It crashed, ran out of context, or was killed. It had no chance to write a brief or to commit."
        echo
        echo "🛑 Issue $id ended without setting its status (was '$final')."
        echo "   Treating as a checkpoint. A note is on the Issue. See $log."
        exit 3
        ;;
    esac
  done

  echo
  echo "Runner finished. Board:"
  board
}

on_interrupt() {
  trap - INT TERM
  if [ -n "$CURRENT_ISSUE" ] && [ "$(status "$CURRENT_ISSUE")" = "in-progress" ]; then
    set_status "$CURRENT_ISSUE" ready
    note_issue "$CURRENT_ISSUE" "$CURRENT_LOG" \
      "You interrupted this run. The work is part done at best, and the agent had no chance to write its own brief or to commit. The Issue is back to ready, so read this note and the working tree before you start the queue again."
    echo
    echo "🛑 interrupted. Issue $(id_of "$CURRENT_ISSUE") is back to ready and carries a note."
  else
    echo
    echo "🛑 interrupted."
  fi
  exit 130
}

# ================================================================ CONFIG
# Author everything below. One /my-issue-runner interview fills it in.

ISSUES_DIR="$DIR/issues"
MAX_ISSUES_DEFAULT=9

# Which skill or skills drive each Issue, in order. The first one is invoked as
# the prompt; the rest are dispatched as subagents. At most one skill carrying
# disable-model-invocation is allowed, and it must be first.
drivers_for() {
  case "$1" in
    09) echo "code-review" ;;
    *) echo "implement" ;;
  esac
}

# Harness and model per Issue, as two words: "harness model". Harness is
# claude, opencode or cursor. Model is whatever that harness natively takes.
# An empty line means "use ~/.issue-runner", which is the normal case: the
# default is set once there, and an Issue only appears here when it differs.
assign_for() {
  echo "opencode opencode/grok-4.6"
}

# The subagent roster. On claude this JSON defines the agents. On opencode and
# cursor it is documentation only: those harnesses dispatch whatever agents
# your own configs already define under these names. A model given here is a
# ceiling by convention, not by enforcement: an orchestrator that passes its
# own override reaches past it. Every model defaults to the orchestrator's
# own, so delegating a skill never quietly downgrades the work.
AGENTS='{
  "deepseek": {
    "description": "General-purpose subagent (DeepSeek V4 Flash via OpenCode Go). Reading, searching, research and mechanical fan-out work.",
    "prompt": "You are a general-purpose subagent. Do exactly what the orchestrator asks. Report findings concisely with file paths and line numbers. Never edit files unless the task explicitly says to.",
    "model": "deepseek"
  }
}'

# The same roster as plain words. This text is glued into the prompt on every
# harness, so it is the only part of the roster opencode and cursor ever see.
ROSTER_TEXT='- deepseek (DeepSeek V4 Flash via OpenCode Go): general-purpose subagent for reading, searching, research and mechanical fan-out. Dispatch it through the task tool with subagent_type deepseek.'

main "$@"
