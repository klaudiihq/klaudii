# Chrome Extension — Release Process

## Overview

The Klaudii Chrome extension provides a side panel for managing Claude Code sessions from the browser.

## Architecture

- **Source files**: `extension/` directory (manifest.json, sidepanel, background, content scripts)
- **Distribution**: Chrome Web Store (or sideloaded for development)
- **Permissions**: Requires connection to local Klaudii server (localhost:9876)

## TODO

- [ ] Document Chrome Web Store publishing flow (developer account, review process)
- [ ] Add version bump script (updates manifest.json version)
- [ ] Document how to build/package the .crx or .zip for submission
- [ ] Add automated testing (extension integration tests)
- [ ] Document sideloading instructions for development/testing
- [ ] Set up CI to validate manifest and lint extension code on PR
