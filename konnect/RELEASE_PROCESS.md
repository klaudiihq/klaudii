# Kloud Konnect (konnect.klaudii.com) — Release Process

## Overview

The cloud relay server at konnect.klaudii.com is deployed to **Fly.io** as the `klaudii-cloud-relay` app.

## Architecture

- **Server code**: `konnect/server/` (Express + WebSocket relay, SQLite DB, Google OAuth)
- **Client code**: `konnect/client/` (local server's cloud connector)
- **Shared code**: `konnect/shared/` (crypto utilities used by both)
- **Public assets**: `konnect/server/public/` (login, pair, dashboard pages, konnect.css)
- **Dashboard iframe**: Serves `public/` (main Klaudii dashboard) at `/dashboard/` for cloud access
- **Dockerfile**: `konnect/server/Dockerfile`
- **Fly config**: `fly.toml` at repo root

## Deploy Steps

```bash
# From the repo root (main worktree)
cd /Volumes/Fast/bryantinsley/repos/klaudii
fly deploy
```

This builds the Docker image, pushes to Fly's registry, and performs a rolling update. Takes ~30-60 seconds.

### Environment Variables (set via Fly secrets/env)

- `SESSION_SECRET` — Required. Cookie signing key.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth credentials
- `GOOGLE_REDIRECT_URI` — `https://konnect.klaudii.com/auth/google/callback`
- `RELAY_WS_URL` — `wss://konnect.klaudii.com/ws`
- `DB_PATH` — `/data/relay.db` (persistent Fly volume)

### Check Status

```bash
fly status
fly releases
fly logs
```

## TODO

- [ ] Add health check endpoint monitoring / alerting
- [ ] Set up staging environment for testing before production deploy
- [ ] Add automated backup for SQLite database on Fly volume
- [ ] Consider CI/CD pipeline (deploy on push to main)
