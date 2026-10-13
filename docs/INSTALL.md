# Installing Wisp

Wisp is a menu-bar dictation app for Apple Silicon Macs. You hold a key, speak,
and the cleaned-up text lands on your clipboard — or straight into whatever
you're typing in.

Everything runs on your Mac. No audio or text is sent anywhere.

## What you need

- An **Apple Silicon Mac** (M1 or newer). Intel Macs are not supported: Wisp
  transcribes on the GPU with Apple's MLX framework.
- **macOS 13 (Ventura) or later.** Built and tested on macOS 27.
- About **3 GB of free disk space** — the app itself plus the speech model it
  downloads the first time you use it.
- Optional: [Ollama](https://ollama.com) if you want the transcript tidied up
  before it reaches your clipboard (see [Cleanup](#optional-cleanup-with-ollama)).

## Install

1. Download **`Wisp-<version>-arm64.dmg`** from the
   [Releases](https://github.com/benjaminflin/wisp/releases) page.
2. Open the DMG and drag **Wisp** onto the **Applications** shortcut.
3. Open Wisp from Applications. On first launch macOS will refuse — see below.

### macOS will block it the first time

Wisp is **not notarised**, because that requires a paid Apple Developer
account. macOS therefore cannot verify it and will say something like
*"Apple could not verify Wisp is free of malware"* or *"Wisp is damaged"*.
The app is fine; it just hasn't been through Apple's paid process.

Pick whichever of these you prefer:

**The click-through way**

1. Open **Applications** in Finder.
2. **Right-click** (or Control-click) **Wisp** and choose **Open**.
3. Click **Open** in the dialog.

You only have to do this once.

**The terminal way**

```bash
xattr -dr com.apple.quarantine /Applications/Wisp.app
```

That removes the "downloaded from the internet" flag from the app. After that it
opens normally.

If you would rather not do either, the alternative is to build it yourself —
see [Building from source](#building-from-source).

## First launch

Wisp lives in the **menu bar**, not the Dock. Look for the small circle icon.

The first time you dictate, it downloads the Whisper speech model — about
**1.6 GB, once**. Open **Settings** (menu-bar icon → Settings…) to watch the
progress. You can keep using your Mac while it downloads; dictation just won't
transcribe until it finishes.

## Permissions

Wisp asks for two things, and **which app you grant them to matters**. macOS
attributes the request to whatever launched Wisp, so if you start it from a
terminal the terminal gets asked, not Wisp.

| Permission | Needed for | Notes |
| --- | --- | --- |
| **Microphone** | recording your voice | Always required. Without it, nothing works. |
| **Accessibility** | holding a key to talk, and auto-paste | Optional. Use tap-to-toggle and leave auto-paste off to avoid it entirely. |

Settings shows what is and isn't granted, and names the app you need to enable.
If the hold key does nothing, that's the permission to fix.

Accessibility is a broad grant — it lets an app observe and control input
system-wide. Wisp only uses it to notice your hold key going down and up, and to
send ⌘V if you turn auto-paste on. If you'd rather not grant it, set **Mode** to
*Tap a shortcut to start / stop*.

## Using it

- **Hold** the hold key (Right Option by default), speak, and release.
- **Or tap** it quickly to latch recording on, then tap again to stop.
- **Or press ⌘⇧Space** to start and stop, if you prefer a normal shortcut.
- The floating indicator shows a live level meter while listening, then what
  was copied.

Everything is configurable under **Settings**, including the Whisper model size,
a custom vocabulary for names and jargon, and whether transcripts are polished
by a local language model.

## Optional: cleanup with Ollama

Whisper's raw output contains filler words and spoken self-corrections like
*"scratch that"*. Wisp can clean that up with a local model instead of sending
your text to a cloud service.

```bash
brew install ollama        # or download from ollama.com
ollama serve
ollama pull qwen2.5:7b
```

Wisp detects it automatically. This is entirely optional: without Ollama,
transcripts are copied exactly as Whisper heard them, and Settings tells you why
they weren't polished.

## Uninstalling

1. Quit Wisp from its menu-bar menu.
2. Drag **Wisp** from Applications to the Trash.
3. Optionally remove your transcripts, settings and the downloaded model:

```bash
rm -rf ~/Library/Application\ Support/Wisp
rm -rf ~/Library/Caches/Wisp
```

## Troubleshooting

**"Wisp is damaged and can't be opened"** — Gatekeeper, as described above.
Right-click → Open, or run the `xattr` command.

**The hold key does nothing** — Accessibility isn't granted for the app that
launched Wisp. See [Permissions](#permissions).

**Nothing is transcribed** — check the **Microphone** row in Settings. If the
level meter doesn't move while you speak, the wrong input device is selected or
permission was denied.

**It sits on "Transcribing…"** — on the first run this is the model download.
Settings shows a percentage. If it persists after that, please
[open an issue](https://github.com/YOUR-USERNAME/wisp/issues) with the output of
Settings → **Copy diagnostics**, which includes versions and the capture
engine's recent log.

**Transcripts come out unpolished** — Ollama isn't running or the model isn't
pulled. Settings shows the connection state.

## Building from source

If you'd rather not trust a downloaded binary, you can build the same app:

```bash
git clone https://github.com/YOUR-USERNAME/wisp
cd wisp
npm install
npm run runtime   # assembles the relocatable Python runtime
npm run dist      # builds Wisp.app and a ZIP into dist/
npm run dmg       # packages that app into a DMG
```

The build is reproducible from source, and `npm run smoke`, `npm run test:worker`
and `npm run selftest` verify the pipeline end to end.
