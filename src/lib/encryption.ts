/**
 * Authenticated symmetric encryption for anything we hand to the browser.
 *
 * Used by `src/lib/session.ts` to protect Google OAuth tokens at rest in a
 * cookie. Cookies live on the user's machine, so "HTTP-only" only stops
 * JavaScript from reading them — it does not stop the user, or malware on the
 * user's machine, from opening the cookie jar. Encryption is what makes the
 * contents unreadable and, just as importantly, unforgeable.
 *
 * AES-256-GCM is chosen because it is *authenticated*: tampering with a single
 * byte makes decryption fail loudly instead of silently yielding garbage.
 *
 * Node-only (`node:crypto`); never import this into a Client Component.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/** AES-256 requires a 32-byte key. */
const KEY_BYTES = 32;

/** 96-bit IV is the size GCM is specified and optimised for. */
const IV_BYTES = 12;

/** GCM authentication tag length. */
const AUTH_TAG_BYTES = 16;

/**
 * Payload format marker.
 *
 * Prefixing the version means a future change of algorithm or layout can be
 * rolled out without every existing cookie decrypting to nonsense — old
 * payloads are recognised and rejected rather than misread.
 */
const FORMAT_VERSION = "v1";

/**
 * Loads and validates the encryption key.
 *
 * Read lazily on each call so a missing key surfaces as a handled request
 * error rather than a crash at module load (which would break `next build`).
 */
function getKey(): Buffer {
  const rawKey = process.env.TOKEN_ENCRYPTION_KEY;

  if (!rawKey) {
    throw new Error(
      'Missing required environment variable "TOKEN_ENCRYPTION_KEY". ' +
        'Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  const key = Buffer.from(rawKey, "base64");

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. ` +
        "It should be 32 random bytes, base64-encoded.",
    );
  }

  return key;
}

/**
 * Encrypts a UTF-8 string into a cookie-safe token.
 *
 * Output layout: `v1.<base64url(iv || authTag || ciphertext)>`. A fresh random
 * IV per call is mandatory — reusing an IV with the same key catastrophically
 * breaks GCM.
 *
 * @throws If `TOKEN_ENCRYPTION_KEY` is missing or malformed.
 */
export function encryptToString(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);

  return `${FORMAT_VERSION}.${payload.toString("base64url")}`;
}

/**
 * Reverses {@link encryptToString}.
 *
 * Returns `null` — never throws — for every "this payload is not usable"
 * case: wrong version, truncated, tampered with, or encrypted under a key we
 * have since rotated away from. Callers treat `null` as "no session", which
 * degrades a key rotation into a re-login instead of a 500 page.
 */
export function decryptToString(payload: string): string | null {
  const [version, encoded] = payload.split(".");

  if (version !== FORMAT_VERSION || !encoded) {
    return null;
  }

  try {
    const buffer = Buffer.from(encoded, "base64url");

    if (buffer.length <= IV_BYTES + AUTH_TAG_BYTES) {
      return null;
    }

    const iv = buffer.subarray(0, IV_BYTES);
    const authTag = buffer.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const ciphertext = buffer.subarray(IV_BYTES + AUTH_TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(authTag);

    // `final()` is where GCM verifies the auth tag, so this throws on tampering.
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
