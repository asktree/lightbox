#!/usr/bin/env bash
# Build the system-audio capture helper. Outputs ./syscap (arm64 macOS binary).
set -euo pipefail
cd "$(dirname "$0")"
swiftc -O -framework ScreenCaptureKit -framework AVFoundation -framework Accelerate \
  -o syscap syscap.swift
echo "built ./syscap"
