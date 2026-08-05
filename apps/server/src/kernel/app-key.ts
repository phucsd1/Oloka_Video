export function decodeApplicationKey(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("OLOKA_APP_KEY must be unpadded base64url");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== 32) {
    throw new Error("OLOKA_APP_KEY must decode to exactly 32 bytes");
  }
  if (decoded.toString("base64url") !== encoded) {
    throw new Error("OLOKA_APP_KEY must use canonical unpadded base64url");
  }
  return decoded;
}
