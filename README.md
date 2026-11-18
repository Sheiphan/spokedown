# Spokedown

A VS Code extension that reads Markdown aloud with a natural, fully local voice and
highlights each word **in the editor itself** as it is spoken — plus a read-along
preview that does the same on the rendered page.

It understands Markdown structure instead of reading raw syntax: headings get pauses,
tables are announced and read row by row with column labels, code blocks and diagrams
are described rather than spelled out, and LaTeX is spoken as math ("the square root
of d sub k"). Built for technical docs, notes and coding-agent files (`README.md`,
`CLAUDE.md`, `AGENTS.md`, `SKILL.md`, plans).

Everything runs on your machine. No account, no API key, no telemetry.

> **Status:** early (0.x). Works on **macOS, Windows and Linux** (x64 and arm64). Windows and
> Linux support is new — please [report problems](https://github.com/Sheiphan/spokedown/issues).

![Spokedown reading a Markdown file aloud, highlighting each word in the editor and in the read-along preview](https://raw.githubusercontent.com/Sheiphan/spokedown/main/docs/demo.gif)

[Watch the demo with sound (MP4)](https://github.com/Sheiphan/spokedown/raw/main/docs/demo.mp4)

## Features

- **Word-level highlighting in the editor** — block, sentence and the current word, mapped to the exact source text. Auto-scrolls; scroll away and a *Back to reading* button appears.
- **Read-along preview** — a side panel styled like VS Code's Markdown preview (KaTeX math, Mermaid diagrams, tables, code, images) with the same live highlights. Click any word to read from there.
- **Natural local voice** — [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) via ONNX Runtime, with exact word timings from the model's own durations. ~4–8× faster than real time on Apple Silicon.
- **Structure-aware reading**

  | Markdown | Spoken as |
  |---|---|
  | `$\sqrt{d_k}$` | "the square root of d sub k" |
  | display math with matrices | "X equals a three by four matrix" (long equations: "Equation, N lines") |
  | table | "Table, three columns: Symbol, Meaning, Value, four rows." then "Row one: Symbol: …" |
  | ` ```python ` block | "Python code block, three lines." |
  | ` ```mermaid ` | "Diagram: flowchart with six steps." |
  | numeric dump in a bare fence | "Data block, three lines." |
  | `0.99999952` | "about one" (configurable precision) |
  | `` [`attention.py:42`](…) `` | "attention dot P Y, line forty-two" |
  | `SKILL.md` frontmatter | "Skill: name. description." |

- **Starts where you are** — from the cursor's line (mid-sentence if needed); pause, move the cursor, press play, and it continues from the new spot.
- **Controls** — play/pause, next/previous sentence, next/previous heading, skip a whole table or code block, speed 0.5–2×, voice and model pickers.
- **Pronunciation dictionary** — fix how names and acronyms are spoken, in one click from the editor.
- **Pluggable models** — Kokoro (default), Kokoro compact, macOS system voices, or any OpenAI-compatible speech server (e.g. [mlx-audio](https://github.com/Blaizzy/mlx-audio) for Qwen3-TTS and others, Kokoro-FastAPI).
- **Fast re-reads** — synthesized audio is cached on disk; a few sentences are generated ahead of playback.

## Install

Search for **Spokedown** in the VS Code Extensions view (publisher *SheiphanJoseph*), or run:

```bash
code --install-extension SheiphanJoseph.spokedown
```

Requires VS Code 1.100+ on macOS, Windows or Linux (x64 or arm64), running locally (not in a
Remote/SSH/WSL window — there is no sound device there). See [Audio on each OS](#audio-on-each-os).

### From source

Requirements: Node 20+, [pnpm](https://pnpm.io) 9+, VS Code 1.100+.

```bash
git clone https://github.com/Sheiphan/spokedown.git
cd spokedown
pnpm install
pnpm -r build
# link the extension into VS Code
ln -s "$PWD/extensions/vscode" ~/.vscode/extensions/local.spokedown-0.1.0
```

Then run **Developer: Reload Window** in VS Code (twice the first time — VS Code
refreshes its extension cache on the first reload). Open a Markdown file and press
**⌃⌥R** (Ctrl+Alt+R on Windows and Linux), or click **Read** in the status bar.

On first use the Kokoro model (326 MB) is downloaded from Hugging Face into
`~/.cache/spokedown/models` (`%LOCALAPPDATA%\spokedown` on Windows, `$XDG_CACHE_HOME/spokedown` on Linux). That download is the only network access.

## Usage

| Action | macOS keys (Windows/Linux: Ctrl+Alt+…) |
|---|---|
| Play / pause (from the cursor line) | ⌃⌥R |
| Next / previous sentence | ⌃⌥→ / ⌃⌥← |
| Next / previous heading | ⌃⌥↓ / ⌃⌥↑ |
| Skip the current block (table, code, list item) | ⌃⌥J |
| Faster / slower | ⌃⌥= / ⌃⌥- |
| Stop | ⌃⌥S |

Command palette (**Spokedown: …**): *Open Read-Along Preview*, *Read Selection*,
*Read File from Start*, *Select Voice…*, *Select Model…*, *Set Speed…*,
*Show Spoken Script* (exactly what will be said), *Clear Audio Cache*.

Settings live under `spokedown.*`: model, voice, speed, how to read code / tables /
equations / diagrams / frontmatter, number precision, highlight timing
(`spokedown.highlight.leadMs`, `spokedown.audioLatencyMs`) and extra models:

```jsonc
"spokedown.models": [
  { "id": "mlx", "type": "openai", "baseUrl": "http://localhost:8000", "model": "mlx-community/Kokoro-82M-bf16" },
  { "id": "kokoro-fp16", "type": "kokoro-onnx", "modelId": "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped", "dtype": "fp16" }
]
```

## Pacing

Three settings control the rhythm (changes apply immediately, even mid-reading):

| Setting | Default | What it does |
|---|---|---|
| `spokedown.speed` | `1` | Speaking rate (0.5–2). |
| `spokedown.pause.sentenceMs` | `150` | Pause after each sentence. `0` is continuous reading. |
| `spokedown.pause.blockScale` | `1` | Multiplier for the longer pauses after paragraphs, headings, list items, tables and code. `0.5` halves them. |

The voice itself adds about 0.75 s of silence around every sentence; Spokedown trims that
(`spokedown.pause.trimSilence`) so the pause settings are the whole gap.

## Pronunciation dictionary

Technical docs are full of names a voice gets wrong. Put the cursor on a word and run
**Spokedown: Fix Pronunciation…** (also in the editor's right-click menu), type how it should
sound ("kube control"), and it is saved for every file. Or edit the setting directly:

```json
"spokedown.pronunciations": {
  "kubectl": "kube control",
  "nginx": "engine x",
  "K8s": "kates",
  "Claude Code": "klawd code"
}
```

- Lowercase keys ignore case (`kubectl` also matches `Kubectl` and `` `kubectl` ``); keys with a capital match exactly.
- A key with spaces matches a phrase; the longest key wins.
- A key also matches part of an identifier: `kubectl` in `kubectl_apply` → "kube control apply".
- An empty value silences the word.
- Highlighting still follows the original text. Changes apply immediately, even mid-reading.
- **Starter list:** turn on `spokedown.starterPronunciations` for 58 common developer and AI terms
  (`kubectl`, `nginx`, `sudo`, `yaml`, `json`, `mcp`, `llm`, …). It is off by default because the
  respellings are best-effort; your own entries override it, and mapping a word to itself
  (`"json": "json"`) undoes one. [See the list](packages/core/src/starterPronunciations.ts).

## Audio on each OS

Spokedown plays sound by handing a WAV file to a program your OS already has:

| OS | Player | Notes |
|---|---|---|
| macOS | `afplay` | Built in. |
| Windows | PowerShell `System.Media.SoundPlayer` | Built in (Windows PowerShell 5.1). |
| Linux | first found of `paplay`, `pw-play`, `aplay`, `ffplay`, `play` (SoX), `mpv` | Most desktops have one. If not: `sudo apt install pulseaudio-utils` (or `alsa-utils`). |

If highlighting runs ahead of the voice, raise `spokedown.audioLatencyMs` (some Linux
players buffer 200–500 ms). The *macOS system voice* model is macOS-only; Kokoro and
OpenAI-compatible servers work everywhere.

## How it works

```
packages/core      Markdown → speech script: sentences whose every word maps back to a source range
                   (remark + remark-gfm/math/frontmatter; LaTeX → speech with MathJax + speech-rule-engine)
packages/engine    TTS backends (Kokoro ONNX, OpenAI-compatible, macOS say), word-timing alignment,
                   on-disk audio cache, shared/cancellable synthesis jobs
extensions/vscode  playback session, editor decorations, status bar, read-along preview webview
```

- **Word timings** come from the timestamped Kokoro export's per-phoneme durations. When
  the phonemizer merges or splits words ("on the" → one phoneme group), a small
  dynamic-programming alignment by phoneme length keeps every word exact.
- **Audio** plays through the OS's own player (see below); pause and seek restart from an
  exact sample offset of the in-memory audio, so the highlight clock stays precise.
- **The preview** can't be VS Code's own (other extensions can't drive it), so it's a
  webview that renders the same parse tree with source offsets on every text span and
  highlights with the CSS Custom Highlight API.

## Development

```bash
pnpm -r build          # build all packages
pnpm -r test           # unit tests (core, engine, extension)
cd extensions/vscode
pnpm test:e2e          # end-to-end in a downloaded VS Code (silent audio; needs the Kokoro model cached)

cd extensions/vscode
pnpm package darwin-arm64   # build a self-contained .vsix (also darwin-x64, or --all)

cd ../../packages/core && pnpm dump path/to/file.md      # write the spoken script for review
cd packages/engine && pnpm speak path/to/file.md   # synthesize a stretch to out/speak.wav + word timings
```

## Roadmap

- Read-section links above headings, pause-at-table, resume position per file
- Reading Mermaid node labels, optional LLM descriptions of diagrams/equations
- Audio on Windows/Linux, Marketplace / Open VSX release
- An [Orca](https://onorca.dev) plugin and a Claude Code skill built on the same core

## License

The source code is MIT — see [LICENSE](LICENSE).

The **published extension (the packaged `.vsix`) is GPL-3.0** — see
[extensions/vscode/LICENSE](extensions/vscode/LICENSE). Kokoro's `phonemizer` dependency
embeds [eSpeak NG](https://github.com/espeak-ng/espeak-ng) (GPL-3.0), and the package
bundles it, so the distributed whole is GPL-3.0. You can reuse the MIT-licensed code in
`packages/` and `extensions/vscode/src` under MIT on its own terms.

Other components keep their own licenses: Kokoro-82M weights, kokoro-js, transformers.js,
MathJax and speech-rule-engine (Apache-2.0); ONNX Runtime, KaTeX, Mermaid,
unified/remark (MIT).
