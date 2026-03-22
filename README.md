# Water Reminder

A lightweight, cross-platform desktop application that reminds you to drink water at configurable intervals. Built with [Tauri v2](https://tauri.app/) — the Rust backend handles all timer logic and OS integration while a React/TypeScript frontend provides the UI.

---

## What it does

Water Reminder sits quietly on your desktop and fires a periodic hydration reminder at whatever interval you choose (default: 60 minutes). When a reminder fires, it can:

- Send a native OS desktop notification.
- Play a short alert tone synthesized in the browser audio engine (no external audio file needed).
- Bring the app window to the foreground.
- Flash the Windows taskbar or bounce the macOS dock icon.

If you want to be honest about actually drinking water, enable **Require Acknowledgment**: the timer pauses after every reminder and only resumes once you click "I Drank Water!". You can also snooze a reminder to delay it by a configurable number of minutes.
If sound is enabled, you can also have the app repeat the alert tone every 10 seconds until you acknowledge or snooze the reminder.

Settings are automatically saved to disk with a short debounce — nothing is lost if you close and reopen the app.

---

## Features

| Feature | Details |
|---|---|
| Customizable interval | 1 – 1 440 minutes |
| Max reminder count | 1 – 9 999, or unlimited |
| Snooze | Delays the next reminder by 1 – 60 minutes |
| Require acknowledgment | Blocks the timer until you confirm you drank water |
| Desktop notification | OS-native (Windows, macOS, Linux) |
| Alert sound | Synthesized 440 → 880 Hz tone; no audio file needed |
| Repeating alert sound | Optional 10-second repeats until you acknowledge or snooze |
| Window focus | Surfaces the app on reminder; on Windows it does not steal focus |
| Taskbar / dock flash | Flashes taskbar (Windows) or bounces dock icon (macOS) |
| Pause / resume | Saves exact remaining time; counter is preserved |
| Persistent settings | Saved to `settings.json` in the OS app data directory |
| Settings validation | Backend rejects invalid values; errors shown in the UI |

### Timer states

```
Stopped → Running → (reminder fires) → WaitingAck ⟶ Running
                                     ↘ Snooze  →   Running
               ↕ Pause / Resume
```

- **Stopped** – timer inactive, counter reset to 0.
- **Running** – counting down; a live countdown is shown in the UI.
- **Paused** – countdown suspended; remaining time and counter both preserved.
- **WaitingAck** – shown when *Require Acknowledgment* is on; next interval does not start until you acknowledge or snooze.

---

## Settings reference

| Setting | Default | Range | Notes |
|---|---|---|---|
| Reminder interval | 60 min | 1 – 1 440 min | How often the reminder fires |
| Max count | Unlimited | 1 – 9 999 or ∞ | App stops automatically after *N* reminders |
| Snooze duration | 5 min | 1 – 60 min | Delay applied by the Snooze button |
| Require acknowledgment | On | On / Off | Pauses after each reminder until you confirm |
| Play sound | On | On / Off | Alert tone on reminder |
| Repeat sound until action | On | On / Off | Replays every 10 seconds while waiting for acknowledgment |
| Focus window | On | On / Off | Brings window to front; on Windows this avoids stealing focus |
| Flash taskbar | On | On / Off | Flashes taskbar / bounces dock icon on reminder |

> **Note:** All settings are locked while the timer is Running or Paused. Stop the timer first to change them.

Settings are stored in `settings.json` in the platform app data directory:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\water-reminder\` |
| macOS | `~/Library/Application Support/com.waterreminder.desktop/` |
| Linux | `~/.config/water-reminder/` |

---

## Tech stack

| Layer | Technology |
|---|---|
| UI framework | React 18.3 + TypeScript 5.8 |
| Build tool | Vite 6.3 |
| Desktop shell | Tauri 2.10 |
| Backend language | Rust 2021 edition |
| Notifications plugin | tauri-plugin-notification 2.x |
| Persistence plugin | tauri-plugin-store 2.x |
| Serialization | serde / serde_json |

---

## Icon license

- App icon: Bootstrap Icons `droplet-fill`
- Source: <https://icons.getbootstrap.com/icons/droplet-fill/>
- License: MIT (free for personal and commercial use)
- This project generates platform icon files from `src-tauri/icons/bootstrap-droplet.svg`

---

## Prerequisites

### All platforms

- [Node.js](https://nodejs.org/) (LTS recommended)
- [Rust](https://www.rust-lang.org/tools/install) via `rustup`

### Windows (additional)

- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) — usually pre-installed on Windows 11; may need manual install on Windows 10.
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload selected.

### macOS (additional)

- Xcode Command Line Tools (`xcode-select --install`)

---

## Build and run

```bash
# 1. Clone the repository
git clone https://github.com/DrDrrae/Water-Reminder.git
cd Water-Reminder

# 2. Install frontend dependencies
npm install

# 3a. Run in development mode (hot reload, dev console)
npm run tauri dev

# 3b. Build a release package
npm run tauri build
```

The packaged installer is written to `src-tauri/target/release/bundle/`.

### Other available commands

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server only (no Tauri shell) |
| `npm run build` | TypeScript compile + Vite bundle only |
| `npm run preview` | Serve the production frontend locally |

---

## Platform notes

- **Windows** – taskbar flash uses the `Critical` attention type, which flashes both the window frame and the taskbar button until the app is focused. If **Focus window** is enabled, the app is also raised above other windows without taking keyboard focus.
- **macOS** – dock bounce uses the `Critical` attention type (continuous bounce until focused); bundle identifier is `com.waterreminder.desktop`.
- **Linux** – taskbar flash behaviour depends on the window manager (GNOME, KDE, i3, etc.) and is not guaranteed.
- **Closing the app** – if the timer is `Stopped`, closing the window exits immediately. If a reminder session is active (`Running`, `Paused`, or `WaitingAck`), the app asks for confirmation before closing.
- **Audio** – the alert tone uses the Web Audio API inside the WebView. It may be silenced by OS-level mute or by WebView autoplay restrictions in unusual configurations.
- **Notifications** – delivered through the OS-native notification system on each platform (Windows Notification Center, macOS Notification Center, freedesktop D-Bus on Linux). The reminder still fires and the window still flashes even if notifications are blocked at the OS level.
