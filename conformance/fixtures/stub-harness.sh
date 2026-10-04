#!/usr/bin/env bash
# The conformance stub harness (ADR-0036). A server under test launches it in
# place of a real harness binary, through the wrappers
# conformance/harness/stubs.ts writes as `claude`, `opencode` and `agent`
# first on PATH:
#
#   stub-harness.sh <harness name> <the argv the server passed>
#
# It records each launch, then does what the case scripted for it. A launch
# is keyed by its outcome file: `01` for a Ticket's Attempt, `01.attempt-2`
# for one Attempt of a verify round, `01-grader-1` for a grader. A
# terminal-backed launch's argv names no outcome file: unless `_<name>` is
# scripted, it waits, as a TUI does, for the prompt typed into its pane
# (FAKE_HERDR_PANE_INPUT, which the fake herdr sets) and is keyed by the
# outcome file that names. One scripted as `_<name>`, or whose prompt names
# none within 90 seconds, is `_<name>`.
#
# CONFORMANCE_STUBS names the directory holding the scripts and the record:
#   scripts/<key>/steps          how many launches are scripted; the last repeats
#   scripts/<key>/<k>.exit       launch k's exit code
#   scripts/<key>/<k>.outcome    launch k's outcome JSON, verbatim; absent, none
#   scripts/<key>/<k>.marker     launch k's old-protocol misbehaviour: a status
#                                it writes into the Ticket's marker itself
#   scripts/<key>/<k>.stdout     launch k's standard output
#   scripts/<key>/wait           a file to wait for, up to ten seconds, first
#   calls/<key>.<n>/             launch n of the key: seq, argv, cwd, env,
#                                issue and outcome
# A key with no scripts writes a done outcome and exits 0, the same step
# stubStep (conformance/fixtures/pool-fixture.ts) reads for no behaviour.
#
# Portable to the bash 3.2 macOS ships: no associative arrays, no `env -0`.
set -uo pipefail

name="$1"
shift
stubs="${CONFORMANCE_STUBS:?CONFORMANCE_STUBS is not set}"

# A prompt's text names the outcome file, and its first line ends in the
# Ticket file's path. Sets both when the text is a prompt.
issue=""
outcome=""
read_prompt() {
  case "$1" in
    *"outcome as JSON at "*)
      rest="${1#*outcome as JSON at }"
      outcome="${rest%%:*}"
      first="${1%%$'\n'*}"
      issue="${first##* }"
      return 0
      ;;
  esac
  return 1
}

# The prompt rides one argument of every batch argv.
for arg in "$@"; do
  read_prompt "$arg" && break
done

# A terminal-backed launch reads it from its pane instead, once the server
# has typed it in and pressed Enter. It gives up early once the world is
# deleted, so a launch the fake herdr's close left running ends with it.
input="${FAKE_HERDR_PANE_INPUT:-}"
if [ -z "$outcome" ] && [ -n "$input" ] && [ ! -d "$stubs/scripts/_$name" ]; then
  give_up=$(( SECONDS + 90 ))
  while [ "$SECONDS" -lt "$give_up" ] && [ -d "$stubs" ]; do
    if [ -f "$input" ] && read_prompt "$(cat "$input")"; then
      break
    fi
    sleep 0.1
  done
fi

if [ -n "$outcome" ]; then
  key="$(basename "$outcome" .outcome.json)"
else
  key="_$name"
fi

calls="$stubs/calls"
mkdir -p "$calls"
count_file="$calls/$key.count"
n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$n" > "$count_file"
call="$calls/$key.$n"
mkdir -p "$call"

# The launch's place in the order of every launch. mkdir is the lock: it is
# atomic everywhere. A holder killed mid-update cannot wedge the rest, since
# the wait gives up after five seconds and takes the next number anyway.
for _ in $(seq 1 500); do
  mkdir "$calls/.lock" 2>/dev/null && break
  sleep 0.01
done
seq_n=$(( $(cat "$calls/.seq" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$seq_n" > "$calls/.seq"
rmdir "$calls/.lock" 2>/dev/null

printf '%s' "$seq_n" > "$call/seq"
printf '%s\0' "$name" "$@" > "$call/argv"
printf '%s' "$PWD" > "$call/cwd"
printf '%s' "$issue" > "$call/issue"
printf '%s' "$outcome" > "$call/outcome"
for var in $(compgen -e); do printf '%s=%s\0' "$var" "${!var}"; done > "$call/env"

script="$stubs/scripts/$key"
if [ ! -d "$script" ]; then
  [ -n "$outcome" ] || exit 0
  if [[ "$key" =~ -grader-[0-9]+$ ]]; then
    printf '{"status":"done","summary":"summary-%s","commitSha":null,"grade":{"score":8,"verdict":"pass","reasons":"default grade"}}' "$key" > "$outcome"
  else
    printf '{"status":"done","summary":"summary-%s","commitSha":null}' "$key" > "$outcome"
  fi
  exit 0
fi

steps="$(cat "$script/steps")"
k=$(( n < steps ? n : steps ))
if [ -f "$script/wait" ]; then
  wait_for="$(cat "$script/wait")"
  for _ in $(seq 1 200); do
    [ -e "$wait_for" ] && break
    sleep 0.05
  done
fi
if [ -f "$script/$k.stdout" ]; then
  cat "$script/$k.stdout"
fi
if [ -f "$script/$k.marker" ] && [ -n "$issue" ]; then
  # In place on line 1, through awk rather than `sed -i`, whose flag BSD and
  # GNU sed spell differently.
  awk -v s="$(cat "$script/$k.marker")" 'NR==1{sub(/status=[a-z-]*/, "status=" s)} {print}' "$issue" > "$issue.new"
  mv "$issue.new" "$issue"
fi
if [ -f "$script/$k.outcome" ] && [ -n "$outcome" ]; then
  cat "$script/$k.outcome" > "$outcome"
fi
exit "$(cat "$script/$k.exit")"
