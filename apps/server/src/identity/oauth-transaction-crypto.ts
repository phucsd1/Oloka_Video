import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const KEY_VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;

export interface SealedPkceVerifier {
  keyVersion: number;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export function sealPkceVerifier(
  applicationKey: Uint8Array,
  transactionId: string,
  verifier: string,
): SealedPkceVerifier {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    ALGORITHM,
    deriveKey(applicationKey, KEY_VERSION),
    iv,
  );
  cipher.setAAD(createAdditionalAuthenticatedData(transactionId, KEY_VERSION));
  const ciphertext = Buffer.concat([
    cipher.update(verifier, "utf8"),
    cipher.final(),
  ]);
  return {
    keyVersion: KEY_VERSION,
    iv,
    ciphertext,
    authTag: cipher.getAuthTag(),
  };
}

export function openPkceVerifier(
  applicationKey: Uint8Array,
  transactionId: string,
  sealed: SealedPkceVerifier,
): string {
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      deriveKey(applicationKey, sealed.keyVersion),
      sealed.iv,
    );
    decipher.setAAD(
      createAdditionalAuthenticatedData(transactionId, sealed.keyVersion),
    );
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("PKCE verifier authentication failed");
  }
}

function deriveKey(applicationKey: Uint8Array, keyVersion: number): Buffer {
  if (applicationKey.byteLength !== KEY_LENGTH || keyVersion !== KEY_VERSION) {
    throw new Error("Unsupported OAuth transaction key version");
  }
  return Buffer.from(
    hkdfSync(
      "sha256",
      applicationKey,
      Buffer.from("oloka-video-identity", "utf8"),
      Buffer.from(`oauth-transaction/pkce/v${keyVersion}`, "utf8"),
      KEY_LENGTH,
    ),
  );
}

function createAdditionalAuthenticatedData(
  transactionId: string,
  keyVersion: number,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      algorithm: "AES-256-GCM",
      keyVersion,
      transactionId,
    }),
    "utf8",
  );
}
