#!/usr/bin/env bash
# ==============================================================================
# avisame.sh — Cross-platform auditory telemetry and desktop notification wrapper
# ==============================================================================
set -u

START_TIME=$(date +%s)
CMD_STR="$*"

format_duration() {
    local total_seconds=$1
    local minutes=$((total_seconds / 60))
    local seconds=$((total_seconds % 60))
    if [ "$minutes" -gt 0 ]; then
        echo "${minutes}m ${seconds}s"
    else
        echo "${seconds}s"
    fi
}

play_sound() {
    local type="$1"
    case "$(uname -s)" in
        Linux*)
            local snd=""
            # Primary: sound-icons directory
            if [ -d "/usr/share/sounds/sound-icons" ]; then
                case "$type" in
                    start) snd="/usr/share/sounds/sound-icons/pisk-up-cink.wav" ;;
                    running) snd="/usr/share/sounds/sound-icons/glass-water-1.wav" ;;
                    error) snd="/usr/share/sounds/sound-icons/chord-7.wav" ;;
                    fanfare|batch_done) snd="/usr/share/sounds/sound-icons/trumpet-1.wav" ;;
                    *) snd="/usr/share/sounds/sound-icons/xylofon.wav" ;;
                esac
            fi
            # Fallback: freedesktop stereo theme
            if [ ! -f "$snd" ] && [ -d "/usr/share/sounds/freedesktop/stereo" ]; then
                case "$type" in
                    start) snd="/usr/share/sounds/freedesktop/stereo/bell.oga" ;;
                    running) snd="/usr/share/sounds/freedesktop/stereo/audio-volume-change.oga" ;;
                    error) snd="/usr/share/sounds/freedesktop/stereo/dialog-error.oga" ;;
                    fanfare|batch_done) snd="/usr/share/sounds/freedesktop/stereo/complete.oga" ;;
                    *) snd="/usr/share/sounds/freedesktop/stereo/complete.oga" ;;
                esac
            fi
            if [ -n "$snd" ] && [ -f "$snd" ]; then
                if command -v paplay >/dev/null 2>&1; then
                    paplay "$snd" >/dev/null 2>&1 &
                elif command -v pw-play >/dev/null 2>&1; then
                    pw-play "$snd" >/dev/null 2>&1 &
                elif command -v aplay >/dev/null 2>&1; then
                    aplay -q "$snd" >/dev/null 2>&1 &
                fi
            fi
            ;;
        Darwin*)
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
            ;;
        CYGWIN*|MINGW*|MSYS*)
            local sound_cmd="[System.Media.SystemSounds]::Asterisk.Play()"
            case "$type" in
                start) sound_cmd="[Console]::Beep(800, 150)" ;;
                running) sound_cmd="[Console]::Beep(1000, 100)" ;;
                error) sound_cmd="[System.Media.SystemSounds]::Hand.Play()" ;;
                fanfare|batch_done) sound_cmd="[System.Media.SystemSounds]::Exclamation.Play()" ;;
                *) sound_cmd="[System.Media.SystemSounds]::Asterisk.Play()" ;;
            esac
            if command -v powershell.exe >/dev/null 2>&1; then
                powershell.exe -NoProfile -Command "$sound_cmd" >/dev/null 2>&1 &
            fi
            ;;
    esac
}

send_popup() {
    local urgency="$1"
    local title="$2"
    local msg="$3"
    case "$(uname -s)" in
        Linux*)
            if command -v notify-send >/dev/null 2>&1; then
                notify-send -u "$urgency" "$title" "$msg" 2>/dev/null &
            fi
            ;;
        Darwin*)
            if command -v osascript >/dev/null 2>&1; then
                osascript -e "display notification \"$msg\" with title \"$title\"" 2>/dev/null &
            fi
            ;;
        CYGWIN*|MINGW*|MSYS*)
            if command -v powershell.exe >/dev/null 2>&1; then
                powershell.exe -NoProfile -Command "
                    [reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null
                    \$notify = New-Object System.Windows.Forms.NotifyIcon
                    \$notify.Icon = [System.Drawing.SystemIcons]::Information
                    \$notify.BalloonTipTitle = '$title'
                    \$notify.BalloonTipText = '$msg'
                    \$notify.Visible = \$True
                    \$notify.ShowBalloonTip(3000)
                " >/dev/null 2>&1 &
            fi
            ;;
    esac
}

# --- Direct / Semantic Event Flags ---
if [ "${1:-}" = "--error" ]; then
    shift
    play_sound "error"
    send_popup "critical" "🚨 Error" "${*:-Process failed}"
    exit 1
elif [ "${1:-}" = "--fanfare" ] || [ "${1:-}" = "--batch-done" ]; then
    shift
    play_sound "fanfare"
    send_popup "normal" "🎺 Complete" "${*:-Batch completed}"
    exit 0
elif [ "${1:-}" = "--success" ]; then
    shift
    play_sound "success"
    send_popup "normal" "✅ Success" "${*:-Process completed}"
    exit 0
elif [ "${1:-}" = "--start" ]; then
    shift
    play_sound "start"
    send_popup "low" "🚀 Started" "${*:-Process started}"
    exit 0
elif [ "${1:-}" = "--running" ]; then
    shift
    play_sound "running"
    send_popup "low" "⏳ Running" "${*:-Job in progress}"
    exit 0
fi

# Fallback when invoked without arguments or with a non-executable single string message
if [ $# -eq 0 ]; then
    play_sound "success"
    send_popup "normal" "✅ Complete" "Command finished successfully."
    exit 0
elif [ $# -eq 1 ] && ! command -v "$1" >/dev/null 2>&1 && [ ! -x "$1" ]; then
    play_sound "success"
    send_popup "normal" "✅ Notice" "$1"
    exit 0
fi

# --- Command Wrapper Mode ---
"$@"
EXIT_CODE=$?

DURATION=$(format_duration $(( $(date +%s) - START_TIME )))
SHORT_CMD="$CMD_STR"
if [ "${#SHORT_CMD}" -gt 60 ]; then
    SHORT_CMD="${SHORT_CMD:0:57}..."
fi

if [ "$EXIT_CODE" -eq 0 ]; then
    play_sound "success"
    send_popup "normal" "✅ Completed ($DURATION)" "$SHORT_CMD\n(Exit 0)"
else
    play_sound "error"
    send_popup "critical" "🚨 Failed ($DURATION)" "$SHORT_CMD\n(Exit $EXIT_CODE)"
fi

exit "$EXIT_CODE"
