import os from "node:os";
import path from "node:path";

/** Models and audio cache: ~/.cache/spokedown (macOS, shared with the CLI tools), $XDG_CACHE_HOME on Linux, %LOCALAPPDATA% on Windows. */
export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "spokedown");
  if (platform === "linux" && env.XDG_CACHE_HOME) return path.posix.join(env.XDG_CACHE_HOME, "spokedown");
  return path.posix.join(home, ".cache", "spokedown");
}
