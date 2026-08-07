import { describe, expect, it } from "vitest";
import {
  openPkceVerifier,
  sealPkceVerifier,
} from "./oauth-transaction-crypto.js";

describe("OAuth transaction cryptography", () => {
  it("seals a PKCE verifier with versioned AES-256-GCM and bound transaction AAD", () => {
    const transactionId = "00000000-0000-4000-8000-000000000001";
    const verifier = "private-pkce-verifier-that-must-never-be-plaintext";
    const applicationKey = Buffer.alloc(32, 7);

    const sealed = sealPkceVerifier(applicationKey, transactionId, verifier);
    const second = sealPkceVerifier(applicationKey, transactionId, verifier);

    expect(sealed.keyVersion).toBe(1);
    expect(sealed.iv).toHaveLength(12);
    expect(second.iv.equals(sealed.iv)).toBe(false);
    expect(sealed.authTag).toHaveLength(16);
    expect(sealed.ciphertext.toString("utf8")).not.toContain(verifier);
    expect(openPkceVerifier(applicationKey, transactionId, sealed)).toBe(
      verifier,
    );
    expect(() =>
      openPkceVerifier(
        applicationKey,
        "00000000-0000-4000-8000-000000000002",
        sealed,
      ),
    ).toThrow(/authentication/i);
    expect(() =>
      openPkceVerifier(applicationKey, transactionId, {
        ...sealed,
        keyVersion: 2,
      }),
    ).toThrow(/authentication/i);
  });
});
