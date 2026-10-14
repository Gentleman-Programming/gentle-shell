#!/bin/sh
# Run from an extracted/checkout bundle, not from a remote pipe.
# Only prerequisite tooling is acquired here; standard installation belongs to T4.
set -eu
umask 077
fail() { printf '%s\n' "Bootstrap: $1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "Required utility missing: $1"; }
for utility in dirname awk; do need "$utility"; done
bundle=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd) || fail 'Cannot locate installation bundle'
entry=$bundle/bin/gentle-shell-install.mjs
[ -f "$entry" ] && [ ! -L "$entry" ] || fail 'Future wizard entry is missing; this bundle cannot start a live wizard'
[ -f "$bundle/scripts/installer-downloads.mjs" ] || fail 'Download helper missing from bundle'
for utility in uname mkdir mktemp chmod mv rm sleep wc id ls; do need "$utility"; done
case ${HOME:-} in /*) ;; *) fail 'HOME must be an absolute per-user directory';; esac
# Refuse symlink ancestors and group/world-writable acquisition parents.
check_home=$HOME
while [ "$check_home" != / ]; do
    [ ! -L "$check_home" ] || fail 'Unsafe symlink in HOME path'
    check_home=$(dirname "$check_home")
done
[ -d "$HOME" ] || fail 'HOME directory is missing'
uid=$(id -u)
ls -nd "$HOME" | awk -v uid="$uid" '$3 == uid && substr($1,6,1) != "w" && substr($1,9,1) != "w" {ok=1} END {exit !ok}' || fail 'Unsafe HOME ownership or permissions'
minimum=$(awk -F '"' '{for (i=2; i<=NF-2; i+=2) if ($i == "node" && $(i+2) ~ /^>=[0-9]+\.[0-9]+\.[0-9]+$/) {value=$(i+2); sub(/^>=/, "", value); count++}} END {if (count == 1) print value}' "$bundle/package.json")
[ -n "$minimum" ] || fail 'Cannot establish repository Node minimum'
version_ok() {
    awk -v value="$1" -v minimum="$2" 'BEGIN {
        sub(/^v/, "", value)
        if (value !~ /^[0-9]+\.[0-9]+\.[0-9]+$/) exit 1
        split(value, a, "."); split(minimum, b, ".")
        for (i=1; i<=3; i++) if (length(a[i]) > 9 || (length(a[i]) > 1 && substr(a[i],1,1) == "0")) exit 1
        for (i=1; i<=3; i++) {
            if (a[i]+0 > b[i]+0) exit 0
            if (a[i]+0 < b[i]+0) exit 1
        }
    }'
}
# Any stable version at all: version_ok against 0.0.0 accepts exactly those.
stable_version() { version_ok "$1" 0.0.0; }
# A stock POSIX watchdog avoids assuming GNU timeout on macOS.
# These fixed prerequisite probes get an unignorable deadline, not graceful TERM.
# Signal only our direct child PID; do not kill inherited process groups.
bounded() {
    seconds=$1
    shift
    "$@" &
    version_pid=$!
    (
        sleep "$seconds" &
        sleeper=$!
        trap 'kill -s KILL "$sleeper" 2>/dev/null || :; wait "$sleeper" 2>/dev/null || :; exit 0' TERM
        wait "$sleeper" || :
        kill -s KILL "$version_pid" 2>/dev/null || :
    ) >/dev/null 2>&1 &
    watchdog=$!
    result=0
    wait "$version_pid" || result=$?
    kill "$watchdog" 2>/dev/null || :
    wait "$watchdog" 2>/dev/null || :
    return "$result"
}
tools=
owned=0
# Only the exact directory this attempt claimed; rm -rf never follows links in it.
owned_tools() {
    [ "$owned" = 1 ] && [ -n "$tools" ] || return 1
    case "$tools" in "$HOME"/.gentle-shell-bootstrap-tools.*/*) return 1;; "$HOME"/.gentle-shell-bootstrap-tools.*) ;; *) return 1;; esac
    [ -d "$tools" ] && [ ! -L "$tools" ] && [ -d "$tools/.claim" ] && [ ! -L "$tools/.claim" ]
}
cleanup() {
    if owned_tools; then
        rm -rf "$tools"
    fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
make_tools() {
    tools=$(mktemp -d "$HOME/.gentle-shell-bootstrap-tools.XXXXXXXX") || fail 'Cannot create private tooling directory'
    case "$tools" in "$HOME"/.gentle-shell-bootstrap-tools.*) ;; *) fail 'Conflicting tooling destination';; esac
    [ -d "$tools" ] && [ ! -L "$tools" ] || fail 'Unsafe tooling destination'
    ls -nd "$tools" | awk -v uid="$uid" '$3 == uid && $1 == "drwx------" {ok=1} END {exit !ok}' || fail 'Unsafe tooling ownership'
    # No existing destination is ever reused or replaced.
    mkdir "$tools/.claim" || fail 'Conflicting tooling destination'
    owned=1
    printf '%s\n' 'gentle-pi prerequisite tooling only' > "$tools/.bootstrap-owned" || fail 'Cannot mark tooling ownership'
}
acquire_node=1
if command -v node >/dev/null 2>&1; then
    node=$(command -v node)
    version=$(bounded 10 "$node" --version 2>/dev/null) || fail 'Existing Node version probe failed'
    if version_ok "$version" "$minimum"; then acquire_node=0
    # An older stable Node is left as it is: the verified Node below runs the
    # installer instead, exactly as when Node is absent.
    elif ! stable_version "$version"; then fail 'Existing Node is incompatible or unknown; refusing replacement'; fi
fi
if [ "$acquire_node" = 1 ]; then
    os=$(uname -s)
    arch=$(uname -m)
    case "$os" in Darwin) os=darwin;; Linux) os=linux;; *) fail 'Unsupported POSIX platform';; esac
    case "$arch" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) fail 'Unsupported architecture';; esac
    if [ "$os" = linux ]; then
        need getconf
        libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'Cannot establish native glibc compatibility; musl is not supported'
        case "$libc" in 'glibc '*) ;; *) fail 'Unsupported libc; only native glibc acquisition is planned';; esac
        version_ok "${libc#glibc }.0" '2.28.0' || fail 'Native Node requires glibc >=2.28; musl is not supported'
    fi
    # Primary source: https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
    # Exact release URLs are fixed, even though the provenance page is moving.
    case "$os-$arch" in
        darwin-arm64) hash=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057;;
        darwin-x64) hash=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097;;
        linux-arm64) hash=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5;;
        linux-x64) hash=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff;;
    esac
    need curl
    need tar
    if command -v sha256sum >/dev/null 2>&1; then hasher=sha256sum
    elif command -v shasum >/dev/null 2>&1; then hasher=shasum
    else fail 'Required SHA256 utility missing: sha256sum or shasum'; fi
    make_tools
    stem=node-v24.21.0-$os-$arch
    archive=$tools/node.tar.gz
    # Also bound disk use on older curl versions lacking streamed-size enforcement.
    # POSIX uses 512-byte blocks; shells using KiB still impose a 200-MiB ceiling.
    (
        ulimit -f 204800 || exit 1
        curl --fail --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 120 --max-filesize 104857600 --output "$archive" "https://nodejs.org/dist/v24.21.0/$stem.tar.gz"
    ) 2>/dev/null || fail 'Node download failed, was truncated, or its file-size bound is unavailable'
    size=$(wc -c < "$archive")
    [ "$size" -gt 0 ] && [ "$size" -le 104857600 ] || fail 'Node download size is invalid'
    if [ "$hasher" = sha256sum ]; then actual=$(bounded 30 sha256sum "$archive" 2>/dev/null) || fail 'SHA256 process failed'
    else actual=$(bounded 30 shasum -a 256 "$archive" 2>/dev/null) || fail 'SHA256 process failed'; fi
    actual=${actual%% *}
    # Hash tools prefix escaped filenames (e.g. newline/backslash) with a backslash.
    actual=${actual#\\}
    [ "$actual" = "$hash" ] || fail 'Node checksum integrity mismatch'
    mkdir "$tools/staging" || fail 'Conflicting staging destination'
    # Extract only the trusted regular executable, not npm/Corepack or archive links.
    member=$stem/bin/node
    listing=$(bounded 30 tar -tvzf "$archive" "$member" 2>/dev/null) || fail 'Node archive is invalid'
    case "$listing" in -*) ;; *) fail 'Node archive executable is not a regular file';; esac
    bounded 30 tar -xzf "$archive" -C "$tools/staging" "$member" 2>/dev/null || fail 'Node extraction failed'
    candidate=$tools/staging/$member
    [ -f "$candidate" ] && [ ! -L "$candidate" ] || fail 'Node executable missing or unsafe'
    version=$(bounded 10 "$candidate" --version 2>/dev/null) || fail 'Acquired Node cannot execute on this native platform'
    [ "$version" = v24.21.0 ] && version_ok "$version" "$minimum" || fail 'Acquired Node version rejected'
    bounded 10 chmod 700 "$candidate" 2>/dev/null || fail 'Cannot secure acquired Node executable'
    [ ! -e "$tools/node" ] && [ ! -L "$tools/node" ] || fail 'Conflicting Node destination'
    mv "$tools/staging/$stem" "$tools/node" || fail 'Cannot publish verified Node'
    rm -f "$archive" || fail 'Cannot clean owned Node archive'
    rm -rf "$tools/staging" || fail 'Cannot clean owned Node staging'
    node=$tools/node/bin/node
    PATH=$tools/node/bin:$PATH
    export PATH
fi
# The helper creates an equally private tooling directory only if pnpm is absent.
# Do not exec: retain ownership cleanup on any helper/child failure.
"$node" "$bundle/scripts/installer-downloads.mjs" --bootstrap "$bundle" "$tools" || fail 'Prerequisite acquisition or wizard child failed'
# Exit 0 means node/npm/pnpm now persist under $PNPM_HOME or were already the
# user's. A removal problem never turns the completed installation into failure.
if [ "$owned" = 1 ]; then
    mark=
    if owned_tools && [ -f "$tools/.bootstrap-owned" ] && [ ! -L "$tools/.bootstrap-owned" ] &&
        { IFS= read -r mark < "$tools/.bootstrap-owned"; } 2>/dev/null && [ "$mark" = 'gentle-pi prerequisite tooling only' ] &&
        rm -rf "$tools" 2>/dev/null; then :
    else printf '%s\n' "Bootstrap: installation finished, but temporary tools could not be removed: $tools" >&2; fi
fi
owned=0
