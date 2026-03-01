# Klaudii Kloud Konnector

Access your Klaudii servers from anywhere through `konnect.klaudii.com`.

## Architecture

```
Browser (konnect.klaudii.com)
  |
  |  E2E encrypted WebSocket
  v
Kloud Relay (dumb pipe — cannot read your data)
  |
  |  WSS (Ed25519 authenticated)
  v
Your Klaudii Server (home/office)
  |
  |  Local HTTP
  v
Claude Code sessions (tmux)
```

## Security Model

**Zero-trust relay.** The kloud relay forwards encrypted packets between your browser and your Klaudii server. It literally cannot read or modify your dashboard data, even if the relay itself is compromised.

### How it works

1. **Pairing**: You pair your Klaudii server with the relay using a one-time code. During pairing, your server generates a random 256-bit **Konnection Key** that is displayed only on your local dashboard — it never touches the relay.

2. **Browser setup**: You enter this Konnection Key in your browser at konnect.klaudii.com. It's stored in your browser's localStorage — never sent to the relay.

3. **E2E encryption**: Every API request from your browser is encrypted with AES-256-GCM using a key derived (HKDF) from the Konnection Key. The relay forwards the encrypted blob to your Klaudii server, which decrypts it with the same Konnection Key.

4. **Server authentication**: Your Klaudii server authenticates to the relay using an Ed25519 signing keypair generated during pairing. On each konnection, the relay sends a random challenge and the server signs it — proving identity without shared secrets.

### What the relay can see

- That a server is konnected (online/offline)
- Timing and size of API requests (traffic analysis)
- Your Google account email (for login)

### What the relay cannot see

- Dashboard content (workspaces, sessions, git status)
- API request/response bodies
- Your Konnection Key
- Your server's private signing key

## Directory Structure

```
connect/
├── server/          # Kloud relay (deployed to konnect.klaudii.com)
│   ├── index.js     # Express + WebSocket server
│   ├── lib/
│   │   ├── auth.js      # Google OAuth 2.0
│   │   ├── db.js        # SQLite database
│   │   ├── ws-hub.js    # WebSocket konnection manager
│   │   ├── pairing.js   # Pairing code flow
│   │   └── proxy.js     # Status endpoints
│   └── public/      # Kloud UI (login, server picker)
│
├── client/          # Konnector (runs inside local Klaudii)
│   ├── index.js     # Main entry + API routes
│   ├── ws-client.js # WebSocket client to relay
│   ├── crypto.js    # E2E encrypt/decrypt
│   └── pairing.js   # Pairing flow
│
└── shared/          # Shared crypto primitives
    └── crypto.js    # AES-GCM, HKDF, Ed25519
```

## Setup

### Local Klaudii (your machine)

No setup needed — the konnector is built into Klaudii. Just click the **Kloud** button in your dashboard header to start pairing.

### Kloud Relay (self-hosting)

If you want to run your own relay instead of using konnect.klaudii.com:

```bash
cd connect/server
npm install

# Set environment variables
export GOOGLE_CLIENT_ID=your-google-client-id
export GOOGLE_CLIENT_SECRET=your-google-client-secret
export GOOGLE_REDIRECT_URI=https://your-domain.com/auth/google/callback
export SESSION_SECRET=a-long-random-string

npm start
```

### Deploy to Fly.io

```bash
cd connect/server
fly launch
fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... SESSION_SECRET=...
fly volumes create klaudii_data --size 1
fly deploy
```

## Pairing Flow

1. Sign in at konnect.klaudii.com with Google
2. Click **Add Server** → copy the 6-character pairing code
3. Open your local Klaudii dashboard (localhost:9876)
4. Click **Kloud** → enter the pairing code
5. Your server displays a **QR code** and Konnection Key
6. Back on konnect.klaudii.com, **scan the QR code** with your camera (or enter the key manually)
7. Done — click your server to access its dashboard remotely

The QR code encodes `klaudii://<serverId>/<connectionKey>` — everything the browser needs in one scan. The relay never sees this data.

## FAQ

**Q: What if I lose the Konnection Key?**
A: Click the Kloud button on your local dashboard to view it again. You can also unpair and re-pair to generate a new key.

**Q: Can I access from multiple devices?**
A: Yes — each device needs the Konnection Key entered once. View it from your local Klaudii dashboard's Kloud panel.

**Q: What happens if the relay goes down?**
A: Your local Klaudii keeps working normally. You just can't access it remotely until the relay is back.

**Q: Is the terminal accessible remotely?**
A: Not yet — remote terminal access (streaming tmux through the tunnel) is planned for a future release.
