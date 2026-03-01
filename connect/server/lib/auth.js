// Google OAuth 2.0 — direct implementation, no passport dependency

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

function getConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/auth/google/callback";
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }
  return { clientId, clientSecret, redirectUri };
}

function getAuthUrl() {
  const { clientId, redirectUri } = getConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
  });
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
  app.get("/auth/google", (_req, res) => {
    try {
      res.redirect(getAuthUrl());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/auth/google/callback", async (req, res) => {
    const { code } = req.query;
    if (!code) {
      return res.status(400).send("Missing authorization code");
    }

    try {
      const tokens = await exchangeCode(code);
      const userInfo = await getUserInfo(tokens.access_token);

      const user = db.upsertUser(userInfo.id, userInfo.email, userInfo.name);
      req.session.userId = user.id;

      res.redirect("/");
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.status(500).send("Authentication failed");
    }
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
}

module.exports = { setupRoutes, requireAuth };
