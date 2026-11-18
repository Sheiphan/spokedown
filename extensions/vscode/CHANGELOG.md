# Changelog

## 0.4.2

- Replaced the demo video on the README and the Marketplace page. No changes to the extension itself.

## 0.4.1

- Added a demo video to the README and the Marketplace page.

## 0.4.0

- **Much shorter gaps after full stops.** Kokoro pads every sentence with about 0.3 s of silence before and 0.45 s after; that silence is now trimmed (word highlighting stays exact), so each sentence boundary is roughly 0.5 s shorter.
- New settings to tune the rhythm: `spokedown.pause.sentenceMs` (pause after each sentence, default 150; `0` = continuous), `spokedown.pause.blockScale` (multiplier for the longer paragraph, heading and block pauses, default 1) and `spokedown.pause.trimSilence` (turn the trimming off). Changes apply immediately, even mid-reading.

## 0.3.0

- **Pronunciation dictionary** (`spokedown.pronunciations`, and **Spokedown: Fix Pronunciation…** on the word under the cursor). Respell names and acronyms such as `kubectl` → "kube control". Keys can be words, phrases or parts of identifiers; an empty value silences a word. Highlighting still follows the original text.
- Optional **starter list** (`spokedown.starterPronunciations`, off by default) with 58 respellings for common developer and AI terms.

## 0.2.0

- **Windows and Linux support** (x64 and arm64), in addition to macOS. Sound plays through the OS's own player: PowerShell's SoundPlayer on Windows, and `paplay`, `pw-play`, `aplay`, `ffplay`, `play` or `mpv` on Linux.
- On Windows the highlight clock starts when the player reports sound is about to begin, so slow PowerShell start-up no longer shifts highlighting.
- A player that fails now shows an error instead of silently racing through the document.
- Models and cache follow each platform's convention (`%LOCALAPPDATA%` on Windows, `$XDG_CACHE_HOME` on Linux). macOS keeps `~/.cache/spokedown`.
- `spokedown.audioOutput` gains `auto` (the default; `afplay` still works as an alias).
- Warns when used in a Remote/SSH/WSL window, where there is no sound device.

## 0.1.2

- Release tooling only: no changes to the extension itself.

## 0.1.1

- Publish the Intel Mac (darwin-x64) build to the Marketplace; 0.1.0 only reached Apple Silicon.

## 0.1.0

First public release.

- Read Markdown aloud with the Kokoro voice, running locally (Apple Silicon and Intel Macs).
- Word-by-word highlighting in the editor and in a read-along preview.
- Structure-aware reading: tables, code blocks, data blocks, Mermaid diagrams, LaTeX math, frontmatter.
- Start from the cursor, pause and resume from a moved cursor, speed control, next/previous sentence and heading.
- Optional OpenAI-compatible and macOS `say` voices.
