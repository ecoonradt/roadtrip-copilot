#!/usr/bin/env bash
set -e

echo "=== Roadtrip Co-Pilot Environment Setup ==="

ANDROID_ROOT="$HOME/Android/Sdk"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
GRADLE_URL="https://services.gradle.org/distributions/gradle-8.7-bin.zip"

# 1. Setup Android SDK Command-Line Tools
if [ ! -f "$ANDROID_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
    echo "--> Downloading Android SDK Command-Line Tools..."
    mkdir -p "$ANDROID_ROOT/cmdline-tools"
    TMP_DIR=$(mktemp -d)
    curl -L "$CMDLINE_TOOLS_URL" -o "$TMP_DIR/cmdline-tools.zip"
    
    echo "--> Extracting Command-Line Tools..."
    unzip -q "$TMP_DIR/cmdline-tools.zip" -d "$TMP_DIR/extracted"
    rm -rf "$ANDROID_ROOT/cmdline-tools/latest"
    mkdir -p "$ANDROID_ROOT/cmdline-tools/latest"
    mv "$TMP_DIR/extracted/cmdline-tools/"* "$ANDROID_ROOT/cmdline-tools/latest/"
    rm -rf "$TMP_DIR"
    echo "--> Command-line tools installed."
else
    echo "--> Android SDK Command-Line Tools already present."
fi

# 2. Accept SDK Licenses & Install Platforms / Build-Tools
echo "--> Accepting Android SDK licenses..."
yes | "$ANDROID_ROOT/cmdline-tools/latest/bin/sdkmanager" --licenses > /dev/null 2>&1 || true

echo "--> Installing platforms;android-34, build-tools;34.0.0, platform-tools..."
"$ANDROID_ROOT/cmdline-tools/latest/bin/sdkmanager" "platforms;android-34" "build-tools;34.0.0" "platform-tools"

# 3. Setup Gradle Wrapper
if [ ! -f "./gradlew" ]; then
    echo "--> Bootstrapping Gradle 8.7 wrapper..."
    TMP_GRADLE_DIR=$(mktemp -d)
    curl -L "$GRADLE_URL" -o "$TMP_GRADLE_DIR/gradle.zip"
    unzip -q "$TMP_GRADLE_DIR/gradle.zip" -d "$TMP_GRADLE_DIR"
    "$TMP_GRADLE_DIR/gradle-8.7/bin/gradle" wrapper --gradle-version 8.7
    rm -rf "$TMP_GRADLE_DIR"
    chmod +x gradlew
    echo "--> Gradle wrapper initialized."
else
    echo "--> Gradle wrapper already present."
fi

# 4. Verify Local Properties
echo "sdk.dir=$ANDROID_ROOT" > local.properties

echo "=== Environment Setup Complete! ==="
./gradlew --version
