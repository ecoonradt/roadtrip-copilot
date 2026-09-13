#!/usr/bin/env bash
set -e

# Android Auto Desktop Head Unit (DHU) Launch Helper
#
# Default SDK Locations by OS:
# - Linux:   $HOME/Android/Sdk/extras/google/auto
# - macOS:   $HOME/Library/Android/sdk/extras/google/auto
# - Windows: %LOCALAPPDATA%\Android\Sdk\extras\google\auto\desktop-head-unit.exe

SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"
DHU_DIR="$SDK_ROOT/extras/google/auto"

if [ ! -d "$DHU_DIR" ]; then
    # Check macOS default location
    if [ -d "$HOME/Library/Android/sdk/extras/google/auto" ]; then
        DHU_DIR="$HOME/Library/Android/sdk/extras/google/auto"
    else
        echo "Error: Desktop Head Unit not found at $DHU_DIR"
        echo "Install it via Android Studio SDK Manager -> SDK Tools -> Android Auto Desktop Head Unit emulator."
        exit 1
    fi
fi

LIB_DIR="$DHU_DIR/lib/usr/lib/llvm-18/lib:$DHU_DIR/lib/usr/lib/x86_64-linux-gnu"

echo "=== Android Auto Desktop Head Unit (DHU) ==="
echo "Forwarding port 5277 to phone..."
adb forward tcp:5277 tcp:5277 || true

echo "Launching Desktop Head Unit..."
CONFIG_ARG=""
if [[ "$*" != *"-c"* ]] && [[ "$*" != *"--config"* ]]; then
    if [ -f "$DHU_DIR/config/default_wide.ini" ]; then
        CONFIG_ARG="-c $DHU_DIR/config/default_wide.ini"
    fi
fi

if [ -d "$DHU_DIR/lib" ]; then
    export LD_LIBRARY_PATH="$LIB_DIR:${LD_LIBRARY_PATH:-}"
fi

exec "$DHU_DIR/desktop-head-unit" $CONFIG_ARG "$@"
