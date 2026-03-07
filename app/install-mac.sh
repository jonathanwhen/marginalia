#!/bin/bash
# Creates a Marginalia.app in /Applications that runs the live dev code.
# The app always uses the latest code — no rebuild needed after changes.

set -e

APP_NAME="Marginalia"
APP_DIR="/Applications/${APP_NAME}.app"
CONTENTS="${APP_DIR}/Contents"
MACOS="${CONTENTS}/MacOS"
RESOURCES="${CONTENTS}/Resources"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_SUBDIR="${PROJECT_DIR}/app"
ELECTRON="${APP_SUBDIR}/node_modules/.bin/electron"
ICON_SRC="${APP_SUBDIR}/icon.icns"

# Verify electron is installed
if [ ! -f "$ELECTRON" ]; then
  echo "Electron not found. Running npm install..."
  cd "$APP_SUBDIR" && npm install
fi

# Verify icon exists
if [ ! -f "$ICON_SRC" ]; then
  echo "Error: icon.icns not found at ${ICON_SRC}"
  echo "Run this script from the marginalia/app directory."
  exit 1
fi

echo "Installing ${APP_NAME} to /Applications..."

# Clean previous install
rm -rf "$APP_DIR"

# Create .app bundle structure
mkdir -p "$MACOS" "$RESOURCES"

# Copy icon
cp "$ICON_SRC" "${RESOURCES}/icon.icns"

# Create launcher script that runs electron with the live project code
cat > "${MACOS}/${APP_NAME}" << LAUNCHER
#!/bin/bash
export PATH="/usr/local/bin:/opt/homebrew/bin:\$PATH"
exec "${ELECTRON}" "${APP_SUBDIR}" "\$@"
LAUNCHER
chmod +x "${MACOS}/${APP_NAME}"

# Create Info.plist
cat > "${CONTENTS}/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>com.marginalia.app</string>
  <key>CFBundleVersion</key>
  <string>2.1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>2.1.0</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>icon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeExtensions</key>
      <array>
        <string>pdf</string>
      </array>
      <key>CFBundleTypeName</key>
      <string>PDF Document</string>
      <key>CFBundleTypeRole</key>
      <string>Viewer</string>
    </dict>
  </array>
</dict>
</plist>
PLIST

echo "Installed ${APP_NAME} to /Applications"
echo "  - Launches from Spotlight, Launchpad, or Dock"
echo "  - Always runs latest code from ${PROJECT_DIR}"
echo "  - To uninstall: rm -rf '${APP_DIR}'"
