// Sign in with Apple — direct OIDC implementation, no passport dependency
// Uses Node.js built-in crypto and fetch (no new npm dependencies).

const crypto = require("crypto");

const APPLE_AUTH_URL = "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";

// Cache Apple's public keys — they change infrequently
let jwksCache = null;
let jwksCachedAt = 0;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getConfig() {
  const clientId = process.env.APPLE_CLIENT_ID;
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const privateKey = process.env.APPLE_PRIVATE_KEY;
  const redirectUri = process.env.APPLE_REDIRECT_URI || "http://localhost:3000/auth/apple/callback";
  if (!clientId || !teamId || !keyId || !privateKey) {
    throw new Error("APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY must be set");
  }
  return { clientId, teamId, keyId, privateKey, redirectUri };
}

function isConfigured() {
  return !!(
    process.env.APPLE_CLIENT_ID &&
    process.env.APPLE_TEAM_ID &&
    process.env.APPLE_KEY_ID &&
    process.env.APPLE_PRIVATE_KEY
  );
}

// Build the Apple OAuth authorization URL.
// response_mode=form_post is required to receive the user's name.
function getAuthUrl(state) {
  const { clientId, redirectUri } = getConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "form_post",
    scope: "name email",
  });
  if (state) params.set("state", state);
  return `${APPLE_AUTH_URL}?${params}`;
}

// Generate the Apple client secret — a short-lived ES256 JWT signed with
// the private key from Apple Developer (the .p8 file contents).
function generateClientSecret() {
  const { clientId, teamId, keyId, privateKey } = getConfig();
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: teamId,
      iat: now,
      exp: now + 3600, // 1 hour — Apple allows up to 6 months but short is safer
      aud: APPLE_ISSUER,
      sub: clientId,
    })
  ).toString("base64url");

  const data = `${header}.${payload}`;
  const key = crypto.createPrivateKey(privateKey);
  const sig = crypto.sign(null, Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });

  return `${data}.${sig.toString("base64url")}`;
}

// Exchange the authorization code for tokens.
async function exchangeCode(code) {
  const { clientId, redirectUri } = getConfig();
  const clientSecret = generateClientSecret();

  const resp = await fetch(APPLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Apple token exchange failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

// Fetch and cache Apple's JWKS public keys.
async function getAppleJwks() {
  if (jwksCache && Date.now() - jwksCachedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache;
  }
  const resp = await fetch(APPLE_JWKS_URL);
  if (!resp.ok) throw new Error(`Failed to fetch Apple JWKS: ${resp.status}`);
  const { keys } = await resp.json();
  jwksCache = keys;
  jwksCachedAt = Date.now();
  return keys;
}

// Verify Apple's id_token (RS256 JWT) and return the claims.
// Validates: signature, issuer, audience, expiry.
async function verifyIdToken(idToken) {
  const { clientId } = getConfig();
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid id_token format");

  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());

  // Validate standard claims
  if (claims.iss !== APPLE_ISSUER) throw new Error("Invalid id_token issuer");
  if (claims.aud !== clientId) throw new Error("Invalid id_token audience");
  if (claims.exp < Math.floor(Date.now() / 1000)) throw new Error("id_token expired");

  // Find the matching public key
  const keys = await getAppleJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`No Apple public key found for kid: ${header.kid}`);

  // Import and verify using Web Crypto (built into Node 22)
  const publicKey = await crypto.webcrypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], "base64url");

  const valid = await crypto.webcrypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, data);
  if (!valid) throw new Error("Apple id_token signature verification failed");

  return claims;
}

module.exports = { isConfigured, getAuthUrl, exchangeCode, verifyIdToken };
