#!/usr/bin/env bash
# ==============================================================================
# notify.sh — Universal Audio Earcons & Desktop Notifications for Gentle Shell
# ==============================================================================
# Cross-platform: Linux (PulseAudio/PipeWire/ALSA/Canberra), macOS, Windows/WSL
# TUIs & Terminals: Tmux, Zellij, Ghostty, WezTerm, Kitty, iTerm2, VS Code, SSH
# ==============================================================================
set -u

# --- Global Environment Controls ---
# Skip completely in CI or when explicitly disabled
if [ "${CI:-}" = "1" ] || [ "${CI:-}" = "true" ] || [ "${CONTINUOUS_INTEGRATION:-}" = "1" ] || [ "${GENTLE_NOTIFY_DISABLED:-}" = "1" ]; then
    ENABLE_SOUND=0
    ENABLE_POPUP=0
else
    ENABLE_SOUND=${GENTLE_NOTIFY_SOUND:-1}
    ENABLE_POPUP=${GENTLE_NOTIFY_POPUP:-1}
fi

START_TIME=$(date +%s)
CUSTOM_TITLE=""
MUTE_FLAG=0
NO_POPUP_FLAG=0

# --- Environment & Platform Detection ---
IS_DARWIN=0
IS_LINUX=0
IS_WINDOWS=0
IS_WSL=0

case "$(uname -s)" in
    Darwin*) IS_DARWIN=1 ;;
    Linux*)
        IS_LINUX=1
        if [ -f "/proc/version" ] && grep -qi "microsoft" /proc/version 2>/dev/null; then
            IS_WSL=1
        fi
        ;;
    CYGWIN*|MINGW*|MSYS*) IS_WINDOWS=1 ;;
    *) IS_LINUX=1 ;;
esac

# Locate Windows powershell.exe when on WSL or Windows
POWERSHELL_BIN=""
if [ "$IS_WINDOWS" -eq 1 ]; then
    if command -v powershell.exe >/dev/null 2>&1; then
        POWERSHELL_BIN="powershell.exe"
    elif command -v powershell >/dev/null 2>&1; then
        POWERSHELL_BIN="powershell"
    fi
elif [ "$IS_WSL" -eq 1 ]; then
    if command -v powershell.exe >/dev/null 2>&1; then
        POWERSHELL_BIN="powershell.exe"
    elif [ -x "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" ]; then
        POWERSHELL_BIN="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    fi
fi

format_duration() {
    local total_seconds=$1
    local hours=$((total_seconds / 3600))
    local minutes=$(((total_seconds % 3600) / 60))
    local seconds=$((total_seconds % 60))

    if [ "$hours" -gt 0 ]; then
        echo "${hours}h ${minutes}m ${seconds}s"
    elif [ "$minutes" -gt 0 ]; then
        echo "${minutes}m ${seconds}s"
    else
        echo "${seconds}s"
    fi
}

# --- Sound Telemetry (Earcons) ---
play_sound() {
    [ "$ENABLE_SOUND" -eq 0 ] || [ "$MUTE_FLAG" -eq 1 ] && return 0
    local type="$1"

    # macOS
    if [ "$IS_DARWIN" -eq 1 ]; then
        local snd="/System/Library/Sounds/Glass.aiff"
        case "$type" in
            start) snd="/System/Library/Sounds/Tink.aiff" ;;
            running) snd="/System/Library/Sounds/Pop.aiff" ;;
            error) snd="/System/Library/Sounds/Basso.aiff" ;;
            fanfare|batch_done) snd="/System/Library/Sounds/Hero.aiff" ;;
            *) snd="/System/Library/Sounds/Glass.aiff" ;;
        esac
        if [ -f "$snd" ] && command -v afplay >/dev/null 2>&1; then
            afplay "$snd" >/dev/null 2>&1 &
        fi
        return 0
    fi

    # Native Windows (Git Bash/MSYS2) or WSL without native Linux audio
    if [ -n "$POWERSHELL_BIN" ] && { [ "$IS_WINDOWS" -eq 1 ] || { [ "$IS_WSL" -eq 1 ] && [ -z "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ]; }; }; then
        local sound_cmd="[System.Media.SystemSounds]::Asterisk.Play()"
        case "$type" in
            start) sound_cmd="[Console]::Beep(800, 150)" ;;
            running) sound_cmd="[Console]::Beep(1000, 100)" ;;
            error) sound_cmd="[System.Media.SystemSounds]::Hand.Play()" ;;
            fanfare|batch_done) sound_cmd="[System.Media.SystemSounds]::Exclamation.Play()" ;;
            *) sound_cmd="[System.Media.SystemSounds]::Asterisk.Play()" ;;
        esac
        "$POWERSHELL_BIN" -NoProfile -NonInteractive -Command "$sound_cmd" >/dev/null 2>&1 &
        return 0
    fi

    # Linux (Desktop / PipeWire / PulseAudio / ALSA / Canberra)
    if [ "$IS_LINUX" -eq 1 ]; then
        local canberra_id="complete"
        local wav_file=""
        local ogg_file=""

        case "$type" in
            start)
                canberra_id="bell"
                wav_file="/usr/share/sounds/sound-icons/pisk-up-cink.wav"
                ogg_file="/usr/share/sounds/freedesktop/stereo/bell.oga"
                ;;
            running)
                canberra_id="audio-volume-change"
                wav_file="/usr/share/sounds/sound-icons/glass-water-1.wav"
                ogg_file="/usr/share/sounds/freedesktop/stereo/audio-volume-change.oga"
                ;;
            error)
                canberra_id="dialog-error"
                wav_file="/usr/share/sounds/sound-icons/chord-7.wav"
                ogg_file="/usr/share/sounds/freedesktop/stereo/dialog-error.oga"
                ;;
            fanfare|batch_done)
                canberra_id="complete"
                wav_file="/usr/share/sounds/sound-icons/trumpet-1.wav"
                ogg_file="/usr/share/sounds/freedesktop/stereo/complete.oga"
                ;;
            *)
                canberra_id="complete"
                wav_file="/usr/share/sounds/sound-icons/xylofon.wav"
                ogg_file="/usr/share/sounds/freedesktop/stereo/complete.oga"
                ;;
        esac

        # 1. PipeWire / PulseAudio
        if command -v pw-play >/dev/null 2>&1; then
            if [ -f "$wav_file" ]; then pw-play "$wav_file" >/dev/null 2>&1 & return 0;
            elif [ -f "$ogg_file" ]; then pw-play "$ogg_file" >/dev/null 2>&1 & return 0; fi
        fi
        if command -v paplay >/dev/null 2>&1; then
            if [ -f "$wav_file" ]; then paplay "$wav_file" >/dev/null 2>&1 & return 0;
            elif [ -f "$ogg_file" ]; then paplay "$ogg_file" >/dev/null 2>&1 & return 0; fi
        fi

        # 2. Canberra desktop sound event
        if command -v canberra-gtk-play >/dev/null 2>&1; then
            canberra-gtk-play -i "$canberra_id" >/dev/null 2>&1 &
            return 0
        fi

        # 3. ALSA (wav files only)
        if command -v aplay >/dev/null 2>&1 && [ -f "$wav_file" ]; then
            aplay -q "$wav_file" >/dev/null 2>&1 &
            return 0
        fi

        # 4. Fallback: terminal BEL
        if [ -t 2 ]; then
            printf '\a' >&2 2>/dev/null || true
        elif (: > /dev/tty) 2>/dev/null; then
            printf '\a' > /dev/tty 2>/dev/null || true
        fi
    fi
}

# --- Desktop & Terminal Notifications (OSC 777 / OSC 9 / notify-send / osascript) ---
send_popup() {
    [ "$ENABLE_POPUP" -eq 0 ] || [ "$NO_POPUP_FLAG" -eq 1 ] && return 0
    local urgency="$1"
    local title="$2"
    local msg="$3"

    [ -n "$CUSTOM_TITLE" ] && title="$CUSTOM_TITLE"

    local terminal_title="${title//$'\e'/}"
    terminal_title="${terminal_title//$'\a'/}"
    terminal_title="${terminal_title//$'\x9c'/}"
    local terminal_msg="${msg//$'\e'/}"
    terminal_msg="${terminal_msg//$'\a'/}"
    terminal_msg="${terminal_msg//$'\x9c'/}"

    # Terminal OSC escape sequence passthrough:
    # Works across Ghostty, WezTerm, Kitty, Foot, iTerm2, Windows Terminal, and through SSH/Tmux/Zellij
    local tty_out=""
    if [ -t 2 ]; then
        tty_out="/dev/stderr"
    elif (: > /dev/tty) 2>/dev/null; then
        tty_out="/dev/tty"
    fi

    if [ -n "$tty_out" ]; then
        if [ -n "${TMUX:-}" ]; then
            # Tmux DCS passthrough for terminal notification
            printf "\033Ptmux;\033\033]777;notify;%s;%s\033\033\\\033\\" "$terminal_title" "$terminal_msg" > "$tty_out" 2>/dev/null || true
            tmux display-message "$terminal_title: $terminal_msg" 2>/dev/null &
        else
            printf "\033]777;notify;%s;%s\033\\" "$terminal_title" "$terminal_msg" > "$tty_out" 2>/dev/null || true
            printf "\033]9;%s: %s\033\\" "$terminal_title" "$terminal_msg" > "$tty_out" 2>/dev/null || true
        fi
    fi

    # Native Desktop Notifications
    if [ "$IS_DARWIN" -eq 1 ]; then
        if command -v osascript >/dev/null 2>&1; then
            osascript -e 'on run argv' \
                -e 'display notification (item 1 of argv) with title (item 2 of argv)' \
                -e 'end run' -- "$msg" "$title" >/dev/null 2>&1 &
        fi
        return 0
    fi

    if [ "$IS_LINUX" -eq 1 ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        if command -v notify-send >/dev/null 2>&1; then
            notify-send -u "$urgency" "$title" "$msg" 2>/dev/null &
        fi
        return 0
    fi

    if [ -n "$POWERSHELL_BIN" ]; then
        GENTLE_NOTIFY_TITLE="$title" \
        GENTLE_NOTIFY_MSG="$msg" \
        WSLENV="${WSLENV:+${WSLENV}:}GENTLE_NOTIFY_TITLE/u:GENTLE_NOTIFY_MSG/u" \
        "$POWERSHELL_BIN" -NoProfile -NonInteractive -Command "
            [reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null
            \$notify = New-Object System.Windows.Forms.NotifyIcon
            \$notify.Icon = [System.Drawing.SystemIcons]::Information
            \$notify.BalloonTipTitle = \$env:GENTLE_NOTIFY_TITLE
            \$notify.BalloonTipText = \$env:GENTLE_NOTIFY_MSG
            \$notify.Visible = \$True
            \$notify.ShowBalloonTip(3000)
        " >/dev/null 2>&1 &
        return 0
    fi
}

# --- Parse Options & Flags ---
while [ $# -gt 0 ]; do
    case "$1" in
        -m|--mute|--silent)
            MUTE_FLAG=1
            shift
            ;;
        --no-popup)
            NO_POPUP_FLAG=1
            shift
            ;;
        -t|--title)
            if [ $# -lt 2 ]; then
                echo "notify.sh: $1 requires a value" >&2
                exit 2
            fi
            CUSTOM_TITLE="$2"
            shift 2
            ;;
        --error)
            shift
            play_sound "error"
            send_popup "critical" "🚨 Error" "${*:-Process failed}"
            exit 1
            ;;
        --fanfare|--batch-done)
            shift
            play_sound "fanfare"
            send_popup "normal" "🎺 Complete" "${*:-Batch completed}"
            exit 0
            ;;
        --success)
            shift
            play_sound "success"
            send_popup "normal" "✅ Success" "${*:-Process completed}"
            exit 0
            ;;
        --start)
            shift
            play_sound "start"
            send_popup "low" "🚀 Started" "${*:-Process started}"
            exit 0
            ;;
        --running)
            shift
            play_sound "running"
            send_popup "low" "⏳ Running" "${*:-Job in progress}"
            exit 0
            ;;
        --)
            shift
            break
            ;;
        *)
            break
            ;;
    esac
done

# If invoked without command arguments
if [ $# -eq 0 ]; then
    play_sound "success"
    send_popup "normal" "✅ Complete" "Command finished successfully."
    exit 0
fi

# --- Command Wrapper Mode ---
"$@"
EXIT_CODE=$?

DURATION=$(format_duration $(( $(date +%s) - START_TIME )))
SHORT_CMD="$*"
if [ "${#SHORT_CMD}" -gt 60 ]; then
    SHORT_CMD="${SHORT_CMD:0:57}..."
fi

if [ "$EXIT_CODE" -eq 0 ]; then
    play_sound "success"
    send_popup "normal" "✅ Completed ($DURATION)" "$SHORT_CMD (exit 0)"
else
    play_sound "error"
    send_popup "critical" "🚨 Failed ($DURATION)" "$SHORT_CMD (exit $EXIT_CODE)"
fi

exit "$EXIT_CODE"
