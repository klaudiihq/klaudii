# iOS App — Release Process

## Overview

The Klaudii iOS app provides mobile access to Claude Code sessions via Kloud Konnect.

## Architecture

- **Source files**: `iOS/Klaudii/` (Swift, SwiftUI)
- **Xcode project**: `iOS/Klaudii.xcodeproj`
- **Distribution**: App Store (or TestFlight for beta)

## TODO

- [ ] Document Xcode build settings and signing requirements
- [ ] Document App Store Connect submission flow
- [ ] Add version/build number bump process
- [ ] Set up TestFlight for beta distribution
- [ ] Document required capabilities and entitlements
- [ ] Add automated build/test via Xcode Cloud or Fastlane
- [ ] Document how the app connects to konnect.klaudii.com (auth flow, WebSocket tunnel)
