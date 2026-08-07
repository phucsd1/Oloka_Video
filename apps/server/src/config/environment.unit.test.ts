import { describe, expect, it } from "vitest";
import { parseEnvironment } from "./environment.js";

describe("parseEnvironment", () => {
  it("rejects an invalid public port", () => {
    expect(() => parseEnvironment({ PORT: "70000" })).toThrow(/PORT/);
  });

  it("rejects an invalid application key without revealing it", () => {
    const secret = "not+a+key";
    let failure: unknown;
    try {
      parseEnvironment({ OLOKA_APP_KEY: secret });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/base64url/i);
    expect(String(failure)).not.toContain(secret);
  });

  it("keeps the local SQLite database separate from persistent object storage", () => {
    const environment = parseEnvironment({
      NODE_ENV: "test",
      DATABASE_PATH: "/var/lib/oloka/database/oloka.db",
      OBJECT_STORAGE_ROOT: "/data",
      OLOKA_DATABASE_BOOTSTRAP_MODE: "fresh-if-replica-missing",
    });

    expect(environment).toMatchObject({
      databasePath: "/var/lib/oloka/database/oloka.db",
      objectStorageRoot: "/data",
      databaseBootstrapMode: "fresh-if-replica-missing",
      hfS3: {
        endpoint: "https://s3.hf.co/phucsd",
        region: "us-east-1",
        bucket: "oloka-video-dev-data",
        sqlitePrefix: "sqlite-replica/dev",
      },
    });
  });

  it("requires an explicit bootstrap mode and HF S3 credentials in production", () => {
    expect(() => parseEnvironment({ NODE_ENV: "production" })).toThrow(
      /OLOKA_DATABASE_BOOTSTRAP_MODE/,
    );

    expect(() =>
      parseEnvironment({
        NODE_ENV: "production",
        OLOKA_DATABASE_BOOTSTRAP_MODE: "restore-required",
      }),
    ).toThrow(/HF_S3_ACCESS_KEY_ID/);
  });

  it("locks production SQLite to the local canonical database path", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "production",
        DATABASE_PATH: "/data/database/oloka.db",
        OLOKA_DATABASE_BOOTSTRAP_MODE: "restore-required",
        HF_S3_ACCESS_KEY_ID: "access-key-name",
        HF_S3_SECRET_ACCESS_KEY: "secret-key-value",
        OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toThrow(/DATABASE_PATH/);
  });

  it("rejects bootstrap booleans and unknown modes", () => {
    expect(() =>
      parseEnvironment({ OLOKA_DATABASE_BOOTSTRAP_MODE: "true" }),
    ).toThrow(/OLOKA_DATABASE_BOOTSTRAP_MODE/);
    expect(() =>
      parseEnvironment({ OLOKA_DATABASE_BOOTSTRAP_MODE: "automatic" }),
    ).toThrow(/OLOKA_DATABASE_BOOTSTRAP_MODE/);
  });

  it("locks production replication to the isolated production prefix", () => {
    expect(() =>
      parseEnvironment({
        NODE_ENV: "production",
        OLOKA_DATABASE_BOOTSTRAP_MODE: "restore-required",
        HF_S3_SQLITE_PREFIX: "qualification/sqlite-litestream/run",
        HF_S3_ACCESS_KEY_ID: "access-key-name",
        HF_S3_SECRET_ACCESS_KEY: "secret-key-value",
        OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toThrow(/HF_S3_SQLITE_PREFIX/);
  });

  it("requires the complete Google identity configuration in production without echoing secrets", () => {
    const clientSecret = "production-google-client-secret";
    expect(() =>
      parseEnvironment({
        NODE_ENV: "production",
        OLOKA_DATABASE_BOOTSTRAP_MODE: "restore-required",
        HF_S3_ACCESS_KEY_ID: "access-key-name",
        HF_S3_SECRET_ACCESS_KEY: "secret-key-value",
        OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        OLOKA_GOOGLE_CLIENT_SECRET: clientSecret,
      }),
    ).toThrow(/OLOKA_GOOGLE_OIDC_ISSUER/);

    try {
      parseEnvironment({
        NODE_ENV: "production",
        OLOKA_DATABASE_BOOTSTRAP_MODE: "restore-required",
        HF_S3_ACCESS_KEY_ID: "access-key-name",
        HF_S3_SECRET_ACCESS_KEY: "secret-key-value",
        OLOKA_APP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        OLOKA_GOOGLE_CLIENT_SECRET: clientSecret,
      });
    } catch (error) {
      expect(String(error)).not.toContain(clientSecret);
    }
  });
});
