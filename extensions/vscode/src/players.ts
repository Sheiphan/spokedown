// Which command plays a WAV file on this OS. Pure (platform, environment and file-existence
// are parameters) so every platform's choice is unit-testable from any machine.
import fs from "node:fs";
import path from "node:path";

export interface PlayerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** If set, the player prints this line on stdout right before sound starts, so the clock can sync to it. */
  readyMarker?: string;
}

export type PlayerResult = { ok: true; player: PlayerSpec; name: string } | { ok: false; error: string };

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  /** Windows system root, used to find powershell.exe when it is not on PATH. */
  systemRoot?: string;
  exists?: (file: string) => boolean;
}

/** Linux players in order of preference: all of them play 16-bit PCM WAV. */
const LINUX_PLAYERS: { name: string; args: (file: string) => string[] }[] = [
  { name: "paplay", args: (f) => [f] }, // PulseAudio / PipeWire-pulse
  { name: "pw-play", args: (f) => [f] }, // PipeWire
  { name: "aplay", args: (f) => ["-q", f] }, // ALSA
  { name: "ffplay", args: (f) => ["-nodisp", "-autoexit", "-loglevel", "quiet", f] },
  { name: "play", args: (f) => ["-q", f] }, // SoX
  { name: "mpv", args: (f) => ["--no-video", "--really-quiet", "--no-terminal", f] },
];

export const READY_MARKER = "spokedown-go";

// The WAV path travels in an environment variable, so spaces and quotes in it need no escaping.
const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$p = New-Object System.Media.SoundPlayer $env:SPOKEDOWN_WAV",
  "$p.Load()",
  `[Console]::Out.WriteLine('${READY_MARKER}')`,
  "[Console]::Out.Flush()",
  "$p.PlaySync()",
].join("; ");

function findOnPath(names: string[], pathEnv: string, p: path.PlatformPath, exists: (f: string) => boolean): { dir: string; name: string } | undefined {
  const dirs = pathEnv.split(p.delimiter).filter(Boolean);
  for (const name of names) for (const dir of dirs) if (exists(p.join(dir, name))) return { dir, name };
  return undefined;
}

export function resolvePlayer(wavFile: string, opts: ResolveOptions = {}): PlayerResult {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? ((f) => fs.existsSync(f));
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? process.env.Path ?? "";

  if (platform === "darwin") {
    return { ok: true, name: "afplay", player: { command: "afplay", args: [wavFile] } };
  }

  if (platform === "win32") {
    const root = opts.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
    const known = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const onPath = findOnPath(["powershell.exe"], pathEnv, path.win32, exists);
    const command = exists(known) ? known : onPath ? path.win32.join(onPath.dir, onPath.name) : undefined;
    if (!command) return { ok: false, error: "Windows PowerShell (powershell.exe) was not found, so Spokedown cannot play audio." };
    return {
      ok: true,
      name: "PowerShell SoundPlayer",
      player: {
        command,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_SCRIPT],
        env: { SPOKEDOWN_WAV: wavFile },
        readyMarker: READY_MARKER,
      },
    };
  }

  // linux, freebsd, …
  const found = findOnPath(LINUX_PLAYERS.map((p) => p.name), pathEnv, path.posix, exists);
  if (!found) {
    return {
      ok: false,
      error: "No audio player found. Install one of: paplay (pulseaudio-utils), pw-play (pipewire), aplay (alsa-utils), ffplay (ffmpeg), play (sox) or mpv.",
    };
  }
  const spec = LINUX_PLAYERS.find((p) => p.name === found.name)!;
  return { ok: true, name: found.name, player: { command: path.posix.join(found.dir, found.name), args: spec.args(wavFile) } };
}
