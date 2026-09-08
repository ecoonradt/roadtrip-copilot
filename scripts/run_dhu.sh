#!/usr/bin/env bash
set -e

DHU_DIR="/home/eric/Android/Sdk/extras/google/auto"
LIB_DIR="$DHU_DIR/lib/usr/lib/llvm-18/lib:$DHU_DIR/lib/usr/lib/x86_64-linux-gnu"

echo "=== Android Auto Desktop Head Unit (DHU) ==="
echo "Forwarding port 5277 to phone..."
adb forward tcp:5277 tcp:5277 || true

echo "Launching Desktop Head Unit..."
CONFIG_ARG=""
if [[ "$*" != *"-c"* ]] && [[ "$*" != *"--config"* ]]; then
    CONFIG_ARG="-c $DHU_DIR/config/default_wide.ini"
fi

export LD_LIBRARY_PATH="$LIB_DIR:$LD_LIBRARY_PATH"
exec "$DHU_DIR/desktop-head-unit" $CONFIG_ARG "$@"
