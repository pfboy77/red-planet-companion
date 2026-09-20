#!/bin/bash
set -euo pipefail
xcode_version=$(xcodebuild -version)
printf '%s\n' "$xcode_version"
ios_sdk=$(xcrun --sdk iphoneos --show-sdk-version)
printf 'iOS SDK: %s\n' "$ios_sdk"
xcode_major=$(awk '/^Xcode / { split($2, v, "."); print v[1] }' <<< "$xcode_version")
sdk_major=${ios_sdk%%.*}
if [[ ! "$xcode_major" =~ ^[0-9]+$ || ! "$sdk_major" =~ ^[0-9]+$ ]] || (( xcode_major < 26 || sdk_major < 26 )); then
  printf 'Release requires Xcode 26+ and iOS SDK 26+.\n' >&2
  exit 1
fi
