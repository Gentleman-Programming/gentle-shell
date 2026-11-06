#!/bin/sh
# Opt-in Linux clean-machine acceptance for the browser installation wizard.
# Runs the real bootstrap and wizard inside a disposable debian:bookworm-slim
# container as a non-root user. Network access happens only inside that
# container; nothing reads or writes the host HOME. Not part of CI.
#
# Usage: sh scripts/test-installer-acceptance.sh [--worktree]
#   default     bundle = `git archive HEAD`
#   --worktree  bundle = tracked files as they are in the working tree,
#               including uncommitted modifications (untracked files excluded)
# GENTLE_ACCEPTANCE_KEEP=1 keeps a failed run's container for inspection.
set -eu
fail() { printf 'acceptance: %s\n' "$1" >&2; exit 1; }
note() { printf 'acceptance: %s\n' "$1"; }
source_mode='head'
case $# in
    0) ;;
    1) [ "$1" = --worktree ] || fail "unknown argument: $1"; source_mode=worktree;;
    *) fail 'usage: sh scripts/test-installer-acceptance.sh [--worktree]';;
esac
image=debian:bookworm-slim
# Upper bound for the whole installation inside the container.
install_limit=${GENTLE_ACCEPTANCE_INSTALL_SECONDS:-1500}
case $install_limit in ''|*[!0-9]*) fail 'GENTLE_ACCEPTANCE_INSTALL_SECONDS must be a whole number';; esac
command -v docker >/dev/null 2>&1 || fail 'Docker is required; refusing to run anything on the host'
docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable; refusing to run anything on the host'
command -v git >/dev/null 2>&1 || fail 'git is required to package the bundle'
repo=$(git rev-parse --show-toplevel) || fail 'run from inside the repository'
started=$(date +%s)
elapsed() { printf '%ss' "$(( $(date +%s) - started ))"; }
name=gentle-install-acceptance-$$-$started
container=
passed=0
cleanup() {
    if [ -n "$container" ] && [ "$passed" = 0 ] && [ "${GENTLE_ACCEPTANCE_KEEP:-}" = 1 ]; then
        printf 'acceptance: kept %s; inspect with: docker exec -it -u tester %s bash; remove with: docker rm -f %s\n' "$container" "$container" "$container" >&2
    elif [ -n "$container" ]; then
        docker rm -f "$container" >/dev/null 2>&1 || printf 'acceptance: could not remove container %s\n' "$container" >&2
    fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

note "image $image, bundle from $source_mode"
docker run -d --name "$name" --pull missing "$image" sleep infinity >/dev/null || fail 'cannot start the container'
container=$name
# Clean machine: no Node, npm, pnpm, Pi or Gentle Shell. curl and CA roots are
# bootstrap prerequisites that a stock Debian desktop already has.
docker exec "$container" sh -c 'export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends ca-certificates curl >/dev/null
    useradd --create-home --shell /bin/bash tester
    mkdir /opt/bundle
    for tool in node npm pnpm pi gentle-shell; do if command -v "$tool" >/dev/null; then echo "unexpected $tool" >&2; exit 1; fi; done' \
    || fail 'container preparation failed'
# gentle-shell setup makes 2 anonymous GitHub API requests (upstream Gentle AI's
# latest-engram lookup), limited to 60 per hour per public IP. /rate_limit does
# not consume quota. Stop early instead of failing deep inside setup.
quota=$(docker exec "$container" sh -c 'curl -fsS --max-time 20 -H "Accept: application/vnd.github+json" https://api.github.com/rate_limit' | tr -d ' \n') \
    || fail 'cannot query the GitHub API rate limit from the container'
rate=$(printf '%s' "$quota" | sed -n 's/.*"rate":{\([^}]*\)}.*/\1/p')
remaining=$(printf '%s' "$rate" | sed -n 's/.*"remaining":\([0-9]*\).*/\1/p')
reset=$(printf '%s' "$rate" | sed -n 's/.*"reset":\([0-9]*\).*/\1/p')
[ -n "$remaining" ] && [ -n "$reset" ] || fail 'unexpected GitHub rate limit response'
reset_at=$(date -u -d "@$reset" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || date -u -r "$reset" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || printf 'epoch %s' "$reset")
if [ "$remaining" -lt 5 ]; then
    fail "only $remaining anonymous GitHub API requests remain on this network (setup needs 2); the quota resets at $reset_at. Not starting."
fi
note "GitHub API quota: $remaining anonymous requests left (resets at $reset_at)"
if [ "$source_mode" = head ]; then
    git -C "$repo" archive --format=tar HEAD
else
    git -C "$repo" ls-files -z | tar -C "$repo" --null -T - -cf -
fi | docker exec -i "$container" tar --no-same-owner -xf - -C /opt/bundle || fail 'cannot copy the bundle'
note "prepared in $(elapsed)"

bootstrap_started=$(date +%s)
# A terminal session exports SHELL (the user's login shell); docker exec does
# not. pnpm setup needs it to pick the profile to edit, and fails with
# ERR_PNPM_UNKNOWN_SHELL without it.
docker exec -d -u tester -w /home/tester -e SHELL=/bin/bash "$container" sh -c \
    'sh /opt/bundle/scripts/bootstrap.sh > "$HOME/bootstrap.log" 2>&1; echo $? > "$HOME/bootstrap.status"' \
    || fail 'cannot start the bootstrap'

# Headless browser stand-in: the same requests the wizard page makes.
driver=$(cat <<'DRIVER'
set -eu
log=$HOME/bootstrap.log
say() { printf 'driver: %s\n' "$1"; }
stop() { say "$1"; cat "$log" 2>/dev/null || :; exit 1; }
waited=0
while :; do
    url=$(grep -o 'http://127\.0\.0\.1:[0-9]*/session?code=[A-Za-z0-9_-]*' "$log" 2>/dev/null | head -n 1) || url=
    [ -z "$url" ] || break
    [ ! -f "$HOME/bootstrap.status" ] || stop 'bootstrap exited before printing the session URL'
    waited=$((waited + 1)); [ "$waited" -lt 600 ] || stop 'no session URL after 600 s'
    sleep 1
done
say "session URL after ${waited}s"
origin=${url%%/session*}
jar=$HOME/acceptance-cookies
curl -fsS -c "$jar" -b "$jar" -o /dev/null "$url" || stop 'session redemption failed'
api() { curl -fsS -b "$jar" -H 'X-Gentle-Install: 1' "$@"; }
post() { api -X POST -H "Origin: $origin" -H 'Content-Type: application/json' --data "$1" "$origin$2"; }
plan=$(api "$origin/api/plan") || stop 'plan request failed'
case $plan in *'"blockers":[]'*) ;; *) stop "plan has blockers: $plan";; esac
plan_id=$(printf '%s' "$plan" | sed -n 's/.*"planId":"\([^"]*\)".*/\1/p')
[ -n "$plan_id" ] || stop "plan has no planId: $plan"
say "plan: $(printf '%s' "$plan" | grep -o '"actions":\[[^]]*\]' | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')"
post "{\"planId\":\"$plan_id\",\"consent\":true}" /api/install >/dev/null || stop 'install request rejected'
seq=0
polls=0
while :; do
    progress=$(api "$origin/api/progress?after=$seq") || stop 'progress request failed'
    printf '%s' "$progress" | grep -o '"step":"[^"]*","status":"[^"]*"' | sed 's/"step":"\([^"]*\)","status":"\([^"]*\)"/  step \1: \2/' || :
    last=$(printf '%s' "$progress" | grep -o '"seq":[0-9]*' | tail -n 1 | cut -d: -f2) || last=
    [ -z "$last" ] || seq=$last
    case $progress in *'"running":false'*'"outcome":{'*) break;; esac
    polls=$((polls + 1)); [ "$polls" -lt "$INSTALL_LIMIT" ] || stop "installation still running after $INSTALL_LIMIT s"
    sleep 1
done
outcome=$(printf '%s' "$progress" | sed -n 's/.*"outcome":{"outcome":"\([a-z-]*\)".*/\1/p')
say "outcome: $outcome"
post '{}' /api/shutdown >/dev/null || stop 'shutdown request rejected'
waited=0
until [ -f "$HOME/bootstrap.status" ]; do
    waited=$((waited + 1)); [ "$waited" -lt 60 ] || stop 'bootstrap still running 60 s after shutdown'
    sleep 1
done
status=$(cat "$HOME/bootstrap.status")
say "bootstrap exit status: $status"
cat "$log"
case $outcome in ready|terminal-action-required) [ "$status" = 0 ] || exit 1;; *) exit 1;; esac
DRIVER
)
printf '%s\n' "$driver" | docker exec -i -u tester -w /home/tester -e INSTALL_LIMIT="$install_limit" "$container" sh -s \
    || fail "wizard flow failed after $(elapsed)"
note "bootstrap and wizard finished in $(( $(date +%s) - bootstrap_started ))s"

# A fresh interactive shell must find the persisted stack; the bootstrap tools
# must be gone. bash -i without a terminal warns about job control; harmless.
checks=$(cat <<'CHECKS'
set -eu
for tool in node npm pnpm gentle-shell; do printf '%s -> %s\n' "$tool" "$(command -v "$tool")"; done
printf 'node %s, npm %s, pnpm %s\n' "$(node --version)" "$(npm --version)" "$(pnpm --version)"
gentle-shell --version
for dir in "$HOME"/.gentle-shell-bootstrap-tools.*; do
    if [ -e "$dir" ] || [ -L "$dir" ]; then echo "bootstrap tools left behind: $dir" >&2; exit 1; fi
done
echo 'bootstrap tools removed'
CHECKS
)
docker exec -u tester -w /home/tester "$container" bash -ic "$checks" || fail "fresh-terminal checks failed after $(elapsed)"
# Informational: pnpm setup edits only ~/.bashrc, which non-interactive login
# shells skip on Debian (see docs/install-wizard.md).
if docker exec -u tester -w /home/tester "$container" bash -lc 'command -v gentle-shell' >/dev/null 2>&1; then
    note 'bash -lc resolves gentle-shell'
else
    note 'bash -lc does not resolve gentle-shell (expected: ~/.profile is not edited)'
fi
passed=1
note "PASS in $(elapsed)"
