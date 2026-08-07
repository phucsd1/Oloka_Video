import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export interface PreparedDatabasePath {
  databasePath: string;
  existed: boolean;
}

export async function prepareLocalDatabasePath(input: {
  databasePath: string;
  objectStorageRoot: string;
}): Promise<PreparedDatabasePath> {
  if (hasTraversalSegment(input.databasePath)) {
    throw new Error("Database path must not contain traversal segments");
  }
  if (!isAbsolute(input.databasePath) || !isAbsolute(input.objectStorageRoot)) {
    throw new Error("Database and object storage paths must be absolute");
  }

  const databasePath = resolve(input.databasePath);
  const objectStorageRoot = resolve(input.objectStorageRoot);
  if (isSameOrInside(databasePath, objectStorageRoot)) {
    throw new Error("The live database must be outside object storage");
  }

  await assertNoSymbolicLinkComponent(databasePath);
  await mkdir(dirname(databasePath), { recursive: true });
  await assertNoSymbolicLinkComponent(databasePath);

  const realObjectStorageRoot = await realpathIfPresent(objectStorageRoot);
  const realDatabaseParent = await realpath(dirname(databasePath));
  if (
    realObjectStorageRoot !== undefined &&
    isSameOrInside(realDatabaseParent, realObjectStorageRoot)
  ) {
    throw new Error("The live database resolves inside object storage");
  }

  try {
    const details = await stat(databasePath);
    if (!details.isFile()) throw new Error("Database path is not a file");
    if (details.size === 0) throw new Error("Database file is zero bytes");
    return { databasePath, existed: true };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { databasePath, existed: false };
    throw error;
  }
}

function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]/u).includes("..");
}

async function assertNoSymbolicLinkComponent(path: string): Promise<void> {
  const root = parse(path).root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Database path contains a symbolic link");
      }
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

async function realpathIfPresent(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isSameOrInside(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
