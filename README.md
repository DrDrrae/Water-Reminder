# Water Reminder

A desktop application for Windows that reminds you to drink water at configurable intervals. Built with [Tauri v2](https://tauri.app/) — the Rust backend handles all timer logic and OS integration while a React/TypeScript frontend provides the UI.

> **Platform support:** Water Reminder is developed and tested exclusively on **Windows**. While the Tauri framework is technically cross-platform, no testing is performed on macOS or Linux, bugs on those platforms will not be fixed, and new features will not be developed for them.

---

## What it does

Water Reminder sits quietly on your desktop and fires a periodic hydration reminder at whatever interval you choose (default: 60 minutes). When a reminder fires, it can:

- Send a Windows desktop notification.
- Play a short alert tone synthesized in the browser audio engine (no external audio file needed).
- Bring the app window to the foreground.
- **Keep the window always on top** until you acknowledge or snooze (optional; requires *Bring window to front* to be enabled).
- Flash the Windows taskbar to attract attention.
- Optionally minimize the app window to the taskbar when a reminder session starts and after you acknowledge a reminder.
- Pulse the entire app UI once per second until you acknowledge, snooze, or stop the reminder, darkening in light mode and brightening in dark mode.

If you want to be honest about actually drinking water, enable **Require Acknowledgment**: the timer pauses after every reminder and only resumes once you click "I Drank Water!". You can also snooze a reminder to delay it by a configurable number of minutes.
While the timer is already running, a separate `I Drank Water!` control in the main controls card lets you immediately restart the countdown from the full configured interval without stopping the current reminder session or resetting the reminder count.
If sound is enabled, you can also have the app repeat the alert tone every 10 seconds until you acknowledge or snooze the reminder.

Settings are automatically saved to disk with a short debounce — nothing is lost if you close and reopen the app.

---

## Screenshots

<img width="602" height="887" alt="image" src="https://github.com/user-attachments/assets/a0ca9da2-2db8-48ad-9e7b-51dad1cf5425" />
<img width="602" height="887" alt="image" src="https://github.com/user-attachments/assets/20c193ff-5941-499e-a288-b6ea42b44321" />

---

## Features

| Feature | Details |
|---|---|
| Customizable interval | 1 – 1 440 minutes |
| Max reminder count | 1 – 9 999, or unlimited |
| Snooze | Delays the next reminder by 1 – 60 minutes |
| Require acknowledgment | Blocks the timer until you confirm you drank water |
| Desktop notification | Windows native notification via Windows Notification Center |
| Alert sound | Synthesized 440 → 880 Hz tone; no audio file needed |
| Repeating alert sound | Optional 10-second repeats until you acknowledge or snooze |
| Window focus | Surfaces the app on reminder; on Windows it does not steal focus |
| Taskbar flash | Flashes the Windows taskbar button to signal a pending reminder |
| Acknowledge auto-minimize | Optionally minimizes the window when starting reminders and after `I Drank Water!` in `WaitingAck` |
| Always-on-top while waiting | Keeps the window above all other windows during `WaitingAck`; requires *Focus window* to be enabled |
| Minimize to system tray | Minimizes the window to the Windows system tray (left-click icon to restore, right-click for menu); Windows only |
| Prevent system sleep | Holds a Windows wake lock while the session is active so reminders fire even if the PC would otherwise sleep |
| Virtual desktop aware | When a reminder fires and the app is on a different Windows virtual desktop, it is automatically moved to the active one |
| Theme preference | Follow system, always light, or always dark |
| Launch auto-start | Optionally starts a fresh reminder session automatically on app launch |
| UI flash animation | Full-screen saturation + brightness pulse on every reminder; auto-clears when you acknowledge, snooze, or stop |
| Pause / resume | Saves exact remaining time; counter is preserved |
| Running-state quick reset | `I Drank Water!` restarts the current countdown from the full interval while staying in `Running` |
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
- **Running actions** – you can pause, stop, reset the session, snooze, or click `I Drank Water!` to restart the countdown from the full interval immediately.
- **Paused** – countdown suspended; remaining time and counter both preserved.
- **WaitingAck** – shown when *Require Acknowledgment* is on; next interval does not start until you acknowledge or snooze.

---

## Settings reference

| Setting | Default | Range | Notes |
|---|---|---|---|
| Reminder interval | 60 min | 1 – 1 440 min | How often the reminder fires |
| Max count | Unlimited | 1 – 9 999 or ∞ | App stops automatically after *N* reminders |
| Snooze duration | 5 min | 1 – 60 min | Delay applied by the Snooze button |
| Theme | System | System / Light / Dark | Controls the app's light or dark appearance |
| Auto-start on launch | Off | On / Off | Starts a fresh reminder session automatically when the app opens |
| Require acknowledgment | On | On / Off | Pauses after each reminder until you confirm |
| Play sound | On | On / Off | Alert tone on reminder |
| Repeat sound until action | On | On / Off | Replays every 10 seconds while waiting for acknowledgment |
| Focus window | On | On / Off | Brings window to front; on Windows this avoids stealing focus |
| Always on top while waiting | Off | On / Off | Keeps the window above all others during `WaitingAck`; only available when *Focus window* is on |
| Minimize to system tray | Off | On / Off | Minimizes the window to the Windows system tray instead of the taskbar; left-click the tray icon to restore, right-click for menu; Windows only |
| Prevent system sleep | Off | On / Off | Holds a Windows wake lock while the session is active (Running, Paused, or WaitingAck); Windows only |
| Flash taskbar | On | On / Off | Flashes the Windows taskbar button on reminder |
| Minimize on acknowledge | Off | On / Off | Minimizes the window when starting reminders and after acknowledging a pending reminder |

> **Note:** `Reminder interval`, `Max count`, and `Snooze duration` stay locked during active reminder sessions. `Theme`, `Auto-start on launch`, and notification behavior settings remain editable in `Running`, `Paused`, and `WaitingAck`, and apply immediately or on the next reminder event as appropriate.

Settings are stored in `settings.json` in `%APPDATA%\water-reminder\`.

---

## Tech stack

| Layer | Technology |
|---|---|
| UI framework | React 19.x + TypeScript 6.x |
| Build tool | Vite 8.x |
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

- [Node.js](https://nodejs.org/) `^20.19.0 || >=22.12.0` (required by Vite 8; use the LTS v22 release or newer)
- [Rust](https://www.rust-lang.org/tools/install) via `rustup`
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) — usually pre-installed on Windows 11; may need manual install on Windows 10.
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload selected.

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
npm run build
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

> Water Reminder is developed and tested on **Windows only**. The notes below reflect observed behaviour on Windows. macOS and Linux are not tested, bugs on those platforms will not be investigated, and features will not be added for them.

- **Windows** – taskbar flash uses the `Critical` attention type, which flashes both the window frame and the taskbar button until the app is focused. If **Focus window** is enabled, the app is also raised above other windows without taking keyboard focus. If the app window is on a different virtual desktop when a reminder fires, it is automatically moved to the currently active virtual desktop (requires Windows 10 1607 or later). If **Always on top while waiting** is also enabled, the window stays above all other windows while `WaitingAck` is active and reverts to normal z-order once you acknowledge or snooze. If **Prevent system sleep** is enabled, a `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` wake lock is held on the main thread for the duration of the session, ensuring timers fire reliably even when the system would otherwise sleep.
- **Closing the app** – if the timer is `Stopped`, closing the window exits immediately. If a reminder session is active (`Running`, `Paused`, or `WaitingAck`), the app asks for confirmation before closing.
- **Audio** – the alert tone uses the Web Audio API inside the WebView. It may be silenced by OS-level mute or by WebView autoplay restrictions in unusual configurations.
- **Notifications** – delivered through the Windows Notification Center. The reminder still fires and the window still flashes even if notifications are blocked at the OS level.
