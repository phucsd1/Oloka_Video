import { describe, expect, it, vi } from "vitest";
import { restoreWithLitestream } from "./litestream-restorer.js";

describe("restoreWithLitestream", () => {
  it("uses a bounded, shell-free, integrity-checked conditional restore", async () => {
    const run = vi.fn().mockResolvedValue(undefined);

    await restoreWithLitestream("/var/lib/oloka/database/oloka.db", {
      run,
    });

    expect(run).toHaveBeenCalledWith(
      "litestream",
      [
        "restore",
        "-config",
        "/etc/litestream.yml",
        "-integrity-check",
        "quick",
        "-if-replica-exists",
        "/var/lib/oloka/database/oloka.db",
      ],
      { timeout: 30_000 },
    );
  });

  it("fails closed without exposing process output that could contain secrets", async () => {
    const sensitiveValue = "credential-from-process-output";
    const run = vi.fn().mockRejectedValue(new Error(sensitiveValue));

    let failure: unknown;
    try {
      await restoreWithLitestream("/var/lib/oloka/database/oloka.db", { run });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/Litestream database restore failed/);
    expect(String(failure)).not.toContain(sensitiveValue);
  });
});
