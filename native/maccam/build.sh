#!/bin/sh
# Builds the macOS virtual camera, unsigned (docs/virtual-camera.md):
#   build/mochi-camera                                           the helper
#   build/com.waifucave.mochistudio.camera.systemextension/        the Camera Extension
# The desktop package puts the helper next to the app's executable and the
# extension in Contents/Library/SystemExtensions/. Signing (Developer ID,
# with the provisioning profiles) comes after, in the release workflow.
#
# MOCHI_TEAM_ID (optional): the Apple team ID, for the extension's Mach
# service name (it must begin with an app group of the team).
set -eu
cd "$(dirname "$0")"
ID=com.waifucave.mochistudio.camera
VERSION=$(node -p "require('../../package.json').version")
SERVICE="${MOCHI_TEAM_ID:+$MOCHI_TEAM_ID.}$ID"

swift build -c release --arch arm64 --arch x86_64
BIN=$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)

rm -rf build
mkdir -p "build/$ID.systemextension/Contents/MacOS"
cp "$BIN/mochi-camera" build/mochi-camera
cp "$BIN/MochiCameraExtension" "build/$ID.systemextension/Contents/MacOS/$ID"
sed -e "s/@ID@/$ID/g" -e "s/@VERSION@/$VERSION/g" -e "s/@SERVICE@/$SERVICE/g" \
  Extension-Info.plist > "build/$ID.systemextension/Contents/Info.plist"
plutil -lint "build/$ID.systemextension/Contents/Info.plist"
echo "Built build/mochi-camera and build/$ID.systemextension (unsigned)."
