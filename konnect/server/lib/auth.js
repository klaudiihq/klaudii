// Google + Apple OAuth 2.0 — direct implementation, no passport dependency

const crypto = require("crypto");
const apple = require("./apple");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

// One-time tokens for mobile auth (token -> { userId, expires })
const mobileTokens = new Map();

function getConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/auth/google/callback";
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }
  return { clientId, clientSecret, redirectUri };
}

function getAuthUrl(state) {
  const { clientId, redirectUri } = getConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
  });
  if (state) {
    params.set("state", state);
  }
  return `${GOOGLE_AUTH_URL}?${params}`;
}

async function exchangeCode(code) {
  const { clientId, clientSecret, redirectUri } = getConfig();
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

async function getUserInfo(accessToken) {
  const resp = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error(`User info fetch failed: ${resp.status}`);
  }
  return resp.json();
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

function setupRoutes(app, db) {
  app.get("/auth/google", (req, res) => {
    try {
      // Mobile apps pass ?mobile=1; we forward this via OAuth state param
      // (session cookies don't survive the ephemeral browser's redirect chain)
      const state = req.query.mobile === "1" ? "mobile" : undefined;
      res.redirect(getAuthUrl(state));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/auth/google/callback", async (req, res) => {
    const { code, state } = req.query;
    if (!code) {
      return res.status(400).send("Missing authorization code");
    }

    try {
      const tokens = await exchangeCode(code);
      const userInfo = await getUserInfo(tokens.access_token);

      const user = db.upsertUser(userInfo.id, userInfo.email, userInfo.name);

      // Mobile flow: generate one-time token and redirect to custom URL scheme
      if (state === "mobile") {
        const token = crypto.randomBytes(32).toString("hex");
        mobileTokens.set(token, { userId: user.id, expires: Date.now() + 60000 });
        return res.redirect(`klaudii://auth/callback?token=${token}`);
      }

      req.session.userId = user.id;
      res.redirect("/");
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.status(500).send("Authentication failed");
    }
  });

  // Mobile token exchange: swap one-time token for a session cookie
  app.post("/auth/token-exchange", (req, res) => {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }

    const entry = mobileTokens.get(token);
    if (!entry || Date.now() > entry.expires) {
      mobileTokens.delete(token);
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    mobileTokens.delete(token);
    req.session.userId = entry.userId;
    res.json({ ok: true });
  });

  app.get("/auth/me", requireAuth, (req, res) => {
    const user = db.getUserById(req.session.userId);
    if (!user) {
      req.session = null;
      return res.status(401).json({ error: "User not found" });
    }
    res.json({ id: user.id, email: user.email, name: user.name });
  });

  app.post("/auth/logout", (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  // --- Sign in with Apple ---

  app.get("/auth/apple", (req, res) => {
    try {
      const state = req.query.mobile === "1" ? "mobile" : undefined;
      res.redirect(apple.getAuthUrl(state));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Apple sends a form POST (application/x-www-form-urlencoded), not a GET.
  // The `user` field (name) is only present on the very first authorization.
  app.post("/auth/apple/callback", async (req, res) => {
    const { code, state, user: userJson, error } = req.body;

    if (error) {
      console.error("Apple OAuth error:", error);
      return res.status(400).send("Apple sign-in was cancelled or failed");
    }
    if (!code) {
      return res.status(400).send("Missing authorization code");
    }

    try {
      const tokens = await apple.exchangeCode(code);
      const claims = await apple.verifyIdToken(tokens.id_token);

      // Apple only sends the user's name on the very first sign-in
      let name = null;
      if (userJson) {
        try {
          const parsed = JSON.parse(userJson);
          const { firstName, lastName } = parsed.name || {};
          name = [firstName, lastName].filter(Boolean).join(" ") || null;
        } catch {}
      }

      const user = db.upsertUserByApple(claims.sub, claims.email, name);

      if (state === "mobile") {
        const token = crypto.randomBytes(32).toString("hex");
        mobileTokens.set(token, { userId: user.id, expires: Date.now() + 60000 });
        return res.redirect(`klaudii://auth/callback?token=${token}`);
      }

      req.session.userId = user.id;
      res.redirect("/");
    } catch (err) {
      console.error("Apple OAuth callback error:", err);
      res.status(500).send("Authentication failed");
    }
  });

}

module.exports = { setupRoutes, requireAuth };
