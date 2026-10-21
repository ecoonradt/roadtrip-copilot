#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SKIP_ANDROID=false

for arg in "$@"; do
  case "$arg" in
    --skip-android)
      SKIP_ANDROID=true
      shift
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--skip-android]" >&2
      exit 1
      ;;
  esac
done

echo "=== [1/3] Route Builder Tests & Build ==="
cd "$ROOT_DIR/route-builder"
npm test
npm run build

echo "=== [2/3] AWS CDK Infrastructure Tests & Synth ==="
cd "$ROOT_DIR/infra"
npm run build
npm test
AWS_REGION="${AWS_REGION:-${CDK_DEFAULT_REGION:-us-east-2}}" npx cdk synth --quiet

echo "=== [3/3] Android Unit Tests ==="
if [ "$SKIP_ANDROID" = true ]; then
  echo "Skipping Android unit tests (--skip-android specified)."
else
  # If ANDROID_HOME is not set but standard SDK path exists, export it
  if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Android/Sdk" ]; then
    export ANDROID_HOME="$HOME/Android/Sdk"
  fi

  if [ -n "${ANDROID_HOME:-}" ] || [ -n "${ANDROID_SDK_ROOT:-}" ] || [ -f "$ROOT_DIR/local.properties" ] || [ -d "$HOME/Android/Sdk" ]; then
    cd "$ROOT_DIR"
    ./gradlew testDebugUnitTest
  else
    echo "Warning: Android SDK not detected (no ANDROID_HOME, ANDROID_SDK_ROOT, local.properties, or $HOME/Android/Sdk). Skipping Android tests."
  fi
fi

echo "=== CI Verification Complete: All Checks Passed ==="
