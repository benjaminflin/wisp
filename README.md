# Wisp

Local-first dictation for macOS. Hold a key, speak, let go — the cleaned-up
transcript lands on your clipboard, ready to paste anywhere.

Everything runs on your Mac. Whisper transcribes the audio, a local Qwen model
through Ollama tidies it up, and no audio or text ever leaves the machine.

```
  hold ⌥ / tap shortcut
            │
            ▼
  ┌───────────────────┐   float32 PCM    ┌──────────────────────┐
  │ Python worker     │ ───────────────► │ Whisper via MLX      │
  │ CoreAudio capture │                  │ (Apple GPU, Metal)   │
  └───────────────────┘                  └──────────┬───────────┘
                                                     │ raw transcript
                                                     ▼
  ┌───────────────────┐   HTTP localhost   ┌──────────────────────┐
  │ Electron shell    │ ◄────────────────► │ Ollama + Qwen 2.5    │
  │ tray · HUD · UI   │                    │ punctuation, fillers │
  └─────────┬─────────┘                    │ spoken corrections   │
            │                              └──────────────────────┘
            ▼
      system clipboard
```

## Requirements

- macOS on Apple Silicon (MLX uses the GPU; Intel Macs are not supported)
- Python 3.10 or newer
- Node.js 18 or newer
- [Ollama](https://ollama.com) running locally, with a Qwen model pulled
- ~2 GB of disk for the Whisper weights (plus whatever Qwen needs)

## Setup

```bash
bash scripts/setup.sh
```

That creates a `.venv`, installs `sounddevice` and `mlx-whisper`, installs the
Node packages, generates the icons, and pre-downloads the Whisper model. Every
cache it touches lives inside the project, so it never needs permission to
write to system locations.

Then pull a model for the cleanup stage:

```bash
ollama serve          # if it is not already running
ollama pull qwen2.5:7b
```

## Permissions

Two macOS permissions matter, and **which app you grant them to is what
counts**. macOS attributes the request to the application that launched Wisp —
so if you start it from a terminal inside an editor, the editor gets asked.

| Permission | Needed for | Grant it to |
| --- | --- | --- |
| **Microphone** | recording your voice — always required | the app you launch Wisp from: Wisp itself once packaged, or Terminal.app / iTerm.app when using `npm start` |
| **Accessibility** | the hold-a-key trigger only | the same app. Not needed at all if you use tap-to-toggle |

A note on Accessibility: it allows an app to observe and control input
system-wide, which is a broad grant. It is only used here to notice that your
hold key went down and up. If you would rather not hand that to a terminal or
editor, set **Mode** to `Tap a shortcut to start / stop`, which uses an
ordinary macOS shortcut and needs no special permission.

Wisp never opens a permission dialog on its own. If Accessibility has not been
granted, it says so in Settings and leaves the hold key disabled instead of
nagging you. Click **Grant accessibility** to open the right System Settings
pane, then allow it for that app and relaunch Wisp.

## Running

```bash
npm start            # launch in the menu bar
npm run settings     # launch and open the settings window
```

Wisp lives in the menu bar. Closing the settings window leaves it running.

### Using it

- **Hold** the hold key (Right Option by default) and speak. Release to
  transcribe.
- **Or tap** the hold key quickly and it latches on; tap again to stop. That is
  the same key doing both jobs — the cutoff is the **tap-to-latch window**.
- **Or press the toggle shortcut** (⌘⇧Space by default) if you set Mode to
  `Tap a shortcut to start / stop` or `Both`.
- The floating HUD shows a live level meter while recording, then what was
  copied. Turn it off under **Audio & output → Show the floating status HUD**.

The tray menu has Start/Stop, Cancel, recent transcripts, and Quit.

## Settings worth knowing

- **Whisper model** — `Large v3 Turbo` is the accuracy default. Drop to
  `Small` or `Base` if you want lower latency or less memory; the model is
  loaded once and kept warm, so switching costs a reload.
- **Custom vocabulary** — names, acronyms, and jargon that Whisper tends to
  mangle. Passed as a decoding hint, not a hard constraint.
- **Silence floor** — the level a 20 ms frame must reach to count as speech.
  Three independent checks stand between you and a transcript invented from
  nothing: the clip needs frames clearly above this floor, its loud parts must
  not look like flat broadband noise, and Whisper's own confidence must be
  adequate. Every threshold was set by measuring real speech, and biased so
  that real words are never discarded. Raise it only in a noisy room.
- **Cleanup with Qwen** — turn it off to copy Whisper's raw output verbatim.
  The "Try it" box runs the cleanup on any text so you can see what it does.
- **Play a sound** — the start/stop blips. Turn this off if you would rather
  Wisp stay silent.

### What the cleanup stage actually does

Qwen is asked to edit, never to answer. It fixes punctuation and capitalisation,
drops filler words and false starts, and applies spoken self-corrections:

> **raw** — "meet on tuesday at three pm scratch that make it wednesday at four pm"
>
> **cleaned** — "Meet on Wednesday at 4 p.m."

It is told explicitly to reproduce questions and commands faithfully rather
than act on them, and the response is grammar-constrained to a JSON object so
it cannot wrap the result in commentary. Two guards protect your words: if
Ollama is unreachable or times out, and if the model's output is an implausible
length relative to the input, the raw transcript is used instead. A failed
cleanup never costs you the transcript.

## Testing

```bash
npm run smoke        # worker + Whisper + Qwen, no Electron
npm run test:worker  # silence triage and audio-teardown resilience
npm run selftest     # full app: model, cleanup, clipboard, history
```

Both are quiet — speech is rendered to a WAV file rather than played through
your speakers. `npm run selftest -- --with-speaker` additionally exercises the
live microphone, and that one does make noise. The self-test writes to your
clipboard.

## Troubleshooting

**"Wisp must be launched with Electron, not Node"** — `ELECTRON_RUN_AS_NODE` is
set in your shell, which makes the Electron binary behave like plain Node. The
`npm` scripts clear it for you; if you invoke the binary directly, use
`env -u ELECTRON_RUN_AS_NODE electron .`.

**`sandbox initialization failed` / `GPU process isn't usable`** — you are
running inside an OS-level sandbox that blocks Chromium's own sandbox. Launch
with `npm start -- --no-sandbox --disable-gpu`. This is a quirk of running
inside constrained environments; a normal launch needs neither flag.

**Nothing is transcribed** — check the **Microphone** row in Settings. If the
level meter does not move while you speak, the wrong input device is selected
or permission was denied.

**It hangs on "Transcribing…"** — this was a PortAudio/CoreAudio deadlock while
closing the microphone, not a slow transcription. Wisp now walks away from a
teardown that has not finished in a few seconds, still hands you the transcript
it had already captured, and restarts the capture engine on its own. You may
see a brief note in Settings while it comes back, and the next dictation takes a
few seconds longer while the model reloads.

**The hold key does nothing** — Accessibility access is not granted for the app
that launched Wisp. See [Permissions](#permissions).

**Transcripts come out unedited** — Ollama is not reachable, or the chosen
model is not pulled. Settings shows the connection state, and the **Test
Ollama** button lists what is available.

**Whisper transcribes silence into stock phrases** — raise the silence floor a
little. Wisp already skips clips with no speech-like frames and discards
low-confidence transcripts, so this should be rare.

## Packaging

```bash
npm run dist
```

`electron-builder` produces a `.dmg` in `dist/`. The Python worker and its
virtualenv ship as unpacked resources because Python cannot read from an asar
archive. The build is unsigned, so macOS will still attribute microphone and
accessibility permissions to the terminal you launch it from unless you sign
it.

The Whisper weights are deliberately not bundled — a packaged app downloads
them on first use into the usual Hugging Face cache.

## Layout

```
src/main.js              Electron main: state machine, tray, HUD, pipeline
src/lib/settings.js      validated, persisted preferences
src/lib/worker.js        supervises the Python process, promise-based RPC
src/lib/trigger.js       global shortcut + held-modifier input hook
src/lib/qwen.js          Ollama client, cleanup prompt, output guards
src/renderer/            settings window
src/hud/                 floating status indicator
python/wisp_worker.py    CoreAudio capture + Whisper, JSON-lines over stdio
scripts/setup.sh         one-time environment setup
scripts/smoke.js         headless pipeline test
scripts/make_icons.py    generates every icon from signed distance fields
```

## Privacy

Audio is captured to memory, transcribed on-device, and discarded — nothing is
written to disk. The only network traffic is to `localhost` for Ollama, and to
Hugging Face the first time a Whisper model is downloaded. Recent transcripts
are kept in memory and, if you leave the option on, in a plain JSON file under
the app's data directory; turn off **Remember recent transcripts** to keep them
in memory only.
