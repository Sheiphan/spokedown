import { describe, expect, it } from "vitest";
import { defaultDataDir } from "../src/paths.js";
import { READY_MARKER, resolvePlayer } from "../src/players.js";

const has = (...files: string[]) => (f: string) => files.includes(f);

describe("resolvePlayer", () => {
  it("uses afplay on macOS", () => {
    const r = resolvePlayer("/tmp/a.wav", { platform: "darwin" });
    expect(r).toMatchObject({ ok: true, name: "afplay", player: { command: "afplay", args: ["/tmp/a.wav"] } });
  });

  it("uses PowerShell's SoundPlayer on Windows and passes the path through the environment", () => {
    const wav = "C:\\Users\\Jo Smith's PC\\AppData\\Local\\Temp\\seg-0.wav";
    const known = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const r = resolvePlayer(wav, { platform: "win32", systemRoot: "C:\\Windows", pathEnv: "", exists: has(known) });
    if (!r.ok) throw new Error(r.error);
    expect(r.player.command).toBe(known);
    expect(r.player.env).toEqual({ SPOKEDOWN_WAV: wav });
    expect(r.player.readyMarker).toBe(READY_MARKER);
    expect(r.player.args.join(" ")).not.toContain("Jo Smith"); // no path in the script text → no quoting problems
    expect(r.player.args.join(" ")).toContain("SoundPlayer");
  });

  it("falls back to powershell.exe on PATH, and reports when there is none", () => {
    const onPath = "D:\\ps\\powershell.exe";
    const found = resolvePlayer("x.wav", { platform: "win32", systemRoot: "C:\\Windows", pathEnv: "D:\\ps;C:\\bin", exists: has(onPath) });
    expect(found).toMatchObject({ ok: true });
    const none = resolvePlayer("x.wav", { platform: "win32", systemRoot: "C:\\Windows", pathEnv: "C:\\bin", exists: () => false });
    expect(none).toMatchObject({ ok: false });
  });

  it("picks the first available Linux player in preference order", () => {
    const pathEnv = "/usr/local/bin:/usr/bin";
    expect(resolvePlayer("/t/a.wav", { platform: "linux", pathEnv, exists: has("/usr/bin/aplay", "/usr/bin/paplay") })).toMatchObject({
      name: "paplay",
      player: { command: "/usr/bin/paplay", args: ["/t/a.wav"] },
    });
    expect(resolvePlayer("/t/a.wav", { platform: "linux", pathEnv, exists: has("/usr/local/bin/aplay") })).toMatchObject({
      name: "aplay",
      player: { command: "/usr/local/bin/aplay", args: ["-q", "/t/a.wav"] },
    });
    const ff = resolvePlayer("/t/a.wav", { platform: "linux", pathEnv, exists: has("/usr/bin/ffplay") });
    expect(ff).toMatchObject({ ok: true, name: "ffplay" });
  });

  it("explains what to install when no Linux player exists", () => {
    const r = resolvePlayer("/t/a.wav", { platform: "linux", pathEnv: "/usr/bin", exists: () => false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/paplay.*pw-play.*aplay/);
  });
});

describe("defaultDataDir", () => {
  it("follows each platform's convention", () => {
    expect(defaultDataDir("darwin", {}, "/Users/me")).toBe("/Users/me/.cache/spokedown");
    expect(defaultDataDir("linux", {}, "/home/me")).toBe("/home/me/.cache/spokedown");
    expect(defaultDataDir("linux", { XDG_CACHE_HOME: "/data/cache" }, "/home/me")).toBe("/data/cache/spokedown");
    expect(defaultDataDir("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "C:\\Users\\me")).toBe("C:\\Users\\me\\AppData\\Local\\spokedown");
    expect(defaultDataDir("win32", {}, "C:\\Users\\me")).toBe("C:\\Users\\me\\AppData\\Local\\spokedown");
  });
});
