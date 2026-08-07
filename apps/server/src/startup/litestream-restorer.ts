import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RestoreProcessOptions {
  timeout: number;
}

export type RestoreProcessRunner = (
  executable: string,
  arguments_: string[],
  options: RestoreProcessOptions,
) => Promise<void>;

export async function restoreWithLitestream(
  databasePath: string,
  options: { run?: RestoreProcessRunner } = {},
): Promise<void> {
  const run = options.run ?? runProcess;
  try {
    await run(
      "litestream",
      [
        "restore",
        "-config",
        "/etc/litestream.yml",
        "-integrity-check",
        "quick",
        "-if-replica-exists",
        databasePath,
      ],
      { timeout: 30_000 },
    );
  } catch {
    throw new Error("Litestream database restore failed");
  }
}

async function runProcess(
  executable: string,
  arguments_: string[],
  options: RestoreProcessOptions,
): Promise<void> {
  await execFileAsync(executable, arguments_, {
    timeout: options.timeout,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
}
