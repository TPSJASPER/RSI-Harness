import { resolve } from "node:path";

/** Merge Pi's session metadata without changing its storage or filtering rules. */
export function distinctSessions(groups) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    for (const session of group) {
      const path = resolve(session.path);
      if (seen.has(path)) continue;
      seen.add(path);
      result.push(session);
    }
  }
  return result.sort((left, right) => right.modified.getTime() - left.modified.getTime());
}

/**
 * Pi's built-in --resume and /resume both call SessionManager.list/listAll.
 * Augment those loaders for this CLI run instead of moving/linking legacy files,
 * which would make deletion and renaming in Pi's picker operate on the wrong path.
 * The wrapper is limited to the current project's default session directory.
 */
export function installRememberedSessionListing(manager, cwd, sessionDirectory, rememberedDirectories) {
  const primary = resolve(sessionDirectory);
  const project = resolve(cwd);
  const additional = [...new Set(rememberedDirectories.map(directory => resolve(directory)))]
    .filter(directory => directory !== primary);
  if (additional.length === 0) return () => {};

  const originalList = manager.list;
  const originalListAll = manager.listAll;

  manager.list = async (requestedCwd, directory, onProgress) => {
    const current = await originalList.call(manager, requestedCwd, directory, onProgress);
    // Explicit alternative directories and other projects retain Pi's behavior.
    if (resolve(requestedCwd) !== project ||
      (directory !== undefined && resolve(directory) !== primary)) return current;
    const legacy = await Promise.all(additional.map(dir =>
      originalList.call(manager, requestedCwd, dir)));
    // Pi filters the custom directories by the session header cwd.
    return distinctSessions([current, ...legacy]);
  };

  manager.listAll = async (directoryOrProgress, onProgress) => {
    const current = await originalListAll.call(manager, directoryOrProgress, onProgress);
    // The All Projects tab is intentionally global, as it is in Pi.
    if (typeof directoryOrProgress === "string") return current;
    const legacy = await Promise.all(additional.map(dir =>
      originalListAll.call(manager, dir)));
    return distinctSessions([current, ...legacy]);
  };

  return () => {
    manager.list = originalList;
    manager.listAll = originalListAll;
  };
}
