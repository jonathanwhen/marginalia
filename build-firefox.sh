#!/bin/bash
# Build script for Firefox distribution.
# Copies extension files into dist-firefox/ with the Firefox-compatible manifest.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$SCRIPT_DIR/dist-firefox"

# Clean previous build
rm -rf "$DIST"
mkdir -p "$DIST"

# Copy all extension files (exclude Electron app, build scripts, dist dirs, git)
rsync -a \
  --exclude='app/' \
  --exclude='dist-firefox/' \
  --exclude='node_modules/' \
  --exclude='.git/' \
  --exclude='.gitignore' \
  --exclude='build-firefox.sh' \
  --exclude='manifest.firefox.json' \
  --exclude='TODO.md' \
  --exclude='README.md' \
  "$SCRIPT_DIR/" "$DIST/"

# Replace manifest with Firefox version
cp "$SCRIPT_DIR/manifest.firefox.json" "$DIST/manifest.json"

echo "Firefox build ready in dist-firefox/"
echo "Load as temporary add-on in about:debugging or package with web-ext."
