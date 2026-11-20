const GOOGLE_KEYS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_KEYS_CACHE = "aon-gis-signing-keys-v1";
const GOOGLE_KEYS_RETRY = "aon-gis-keys-retry-v1";
const SHA256_DIGEST_INFO = "3031300d060960864801650304020105000420";

function readGoogleIdToken_(token, clientId, now, findKey) {
  if (typeof token !== "string" || token.length > 12000) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every(isBase64Url_)) return null;

  let header;
  let claims;
  let signature;
  try {
    header = readJwtObject_(parts[0]);
    claims = readJwtObject_(parts[1]);
    signature = fromBase64Url_(parts[2]);
  } catch (_) {
    return null;
  }
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(header.kid) ||
      "crit" in header || "b64" in header) return null;
  if (claims.aud !== clientId || ("azp" in claims && claims.azp !== clientId) ||
      (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com")) return null;
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= now ||
      !Number.isSafeInteger(claims.iat) || claims.iat > now + 120 || claims.exp <= claims.iat ||
      ("nbf" in claims && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 120))) return null;
  if (typeof claims.sub !== "string" || !/^[a-zA-Z0-9_-]{1,255}$/.test(claims.sub) ||
      (claims.email_verified !== true && claims.email_verified !== "true") ||
      typeof claims.email !== "string" || !validEmail_(claims.email)) return null;

  const key = findKey(header.kid);
  if (!key || !verifyGoogleRsa_(key, signature, parts[0] + "." + parts[1])) return null;
  const email = claims.email.toLowerCase();
  // A signed Google account may enter as a guest. Trust an email for the board's
  // allowlist only when Google is authoritative for that address.
  const emailAuthoritative = email.endsWith("@gmail.com") || (typeof claims.hd === "string" && claims.hd.length > 0);
  const normalName = typeof claims.name === "string" ? claims.name.trim().replace(/[\u0000-\u001f\u007f]/g, "") : "";
  return { id: claims.sub, displayName: normalName.slice(0, 100) || "Google 계정", email: email, emailAuthoritative: emailAuthoritative };
}

function isBase64Url_(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value) && value.length % 4 !== 1;
}

function fromBase64Url_(value) {
  if (!isBase64Url_(value)) throw new Error("Invalid base64url");
  return Utilities.base64DecodeWebSafe(value + "=".repeat((4 - value.length % 4) % 4));
}

function readJwtObject_(part) {
  const value = JSON.parse(Utilities.newBlob(fromBase64Url_(part)).getDataAsString("UTF-8"));
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function validEmail_(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function bytesHex_(bytes) {
  return Array.from(bytes, byte => (byte & 255).toString(16).padStart(2, "0")).join("");
}

function rsaPublicPower_(input, exponent, modulus) {
  let result = BigInt(1);
  while (exponent > BigInt(0)) {
    if (exponent % BigInt(2) === BigInt(1)) result = result * input % modulus;
    exponent = exponent / BigInt(2);
    input = input * input % modulus;
  }
  return result;
}

function verifyGoogleRsa_(key, signature, signedText) {
  if (key.kty !== "RSA" || (key.alg && key.alg !== "RS256") || (key.use && key.use !== "sig") ||
      key.e !== "AQAB" || !isBase64Url_(key.n)) return false;
  const bytes = fromBase64Url_(key.n);
  if (bytes.length < 256 || bytes.length > 512 || (bytes[0] & 128) === 0 || signature.length !== bytes.length) return false;
  const modulus = BigInt("0x" + bytesHex_(bytes));
  const input = BigInt("0x" + bytesHex_(signature));
  if (input >= modulus) return false;

  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, signedText, Utilities.Charset.UTF_8);
  const payload = SHA256_DIGEST_INFO + bytesHex_(digest);
  const expected = "0001" + "ff".repeat(bytes.length - 3 - payload.length / 2) + "00" + payload;
  const actual = rsaPublicPower_(input, BigInt(65537), modulus).toString(16).padStart(bytes.length * 2, "0");
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

function cachedGoogleKeys_(cache) {
  try {
    const raw = cache.get(GOOGLE_KEYS_CACHE);
    const decoded = raw ? JSON.parse(raw) : null;
    return decoded && Array.isArray(decoded.keys) ? decoded.keys : [];
  } catch (_) {
    return [];
  }
}

function googleSigningKey_(kid) {
  const cache = CacheService.getScriptCache();
  const choose = keys => keys.find(key => key && key.kid === kid);
  let keys = cachedGoogleKeys_(cache);
  let match = choose(keys);
  if (match) return match;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new BoardError_(503, "SIGN_IN_UNAVAILABLE", "로그인을 확인할 수 없습니다. 잠시 후 시도해 주세요.");
  try {
    keys = cachedGoogleKeys_(cache);
    match = choose(keys);
    if (match) return match;
    if (cache.get(GOOGLE_KEYS_RETRY)) {
      if (keys.length) return null;
      throw new BoardError_(503, "SIGN_IN_UNAVAILABLE", "로그인을 확인할 수 없습니다. 잠시 후 시도해 주세요.");
    }

    // Prevent unknown key IDs from triggering a fetch for every unauthorized request.
    cache.put(GOOGLE_KEYS_RETRY, "1", 30);
    let fetched;
    try {
      const response = UrlFetchApp.fetch(GOOGLE_KEYS_URL, { muteHttpExceptions: true, followRedirects: false });
      if (response.getResponseCode() !== 200) throw new Error("Google keys unavailable");
      const headers = response.getHeaders();
      const header = name => {
        const found = Object.keys(headers).find(key => key.toLowerCase() === name);
        return found ? String(headers[found]) : "";
      };
      fetched = JSON.parse(response.getContentText());
      if (!Array.isArray(fetched.keys) || !fetched.keys.length) throw new Error("Google keys missing");
      const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(header("cache-control"));
      const age = Number(header("age")) || 0;
      const visibleAge = maxAge ? Number(maxAge[1]) - Math.max(age, 0) : 0;
      if (visibleAge > 0) cache.put(GOOGLE_KEYS_CACHE, JSON.stringify(fetched), Math.min(visibleAge, 21600));
    } catch (_) {
      throw new BoardError_(503, "SIGN_IN_UNAVAILABLE", "로그인을 확인할 수 없습니다. 잠시 후 시도해 주세요.");
    }
    return choose(fetched.keys) || null;
  } finally {
    lock.releaseLock();
  }
}
