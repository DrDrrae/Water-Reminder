# Copilot Instructions

## Project Overview

Water Reminder is a Tauri v2 desktop app that sends hydration reminders at configurable intervals. It has a React/TypeScript frontend and a Rust backend (`src-tauri/src/lib.rs`).

**Platform: Windows only.** macOS, Linux, and other platforms are not tested, not supported, and bugs will not be fixed for them. All OS-integration code targets Win32 APIs directly.

## Commands

```bash
npm run tauri dev      # Dev mode with hot reload (starts Vite + Tauri shell)
npm run tauri build    # Release build → src-tauri/target/release/bundle/
npm run build          # TypeScript compile + Vite bundle only (no Tauri shell)
npm run dev            # Vite dev server only (no Tauri shell, UI only)
```

There are no test or lint scripts defined.

## Architecture

**Frontend** (`src/`): Single React component (`App.tsx`, ~1150 lines) with local state, polling, and event listeners. No state management library.

**Backend** (`src-tauri/src/lib.rs`, ~1350 lines): Rust library crate (`water_reminder_lib`). All timer logic, OS integration, and state live here. The `main.rs` entry point just calls `water_reminder_lib::run()`.

**IPC layer**:
- TypeScript → Rust: `invoke("command_name", { payload })` from `@tauri-apps/api/core`
- Rust → TypeScript: events emitted by the timer thread, consumed via `listen("event-name")` from `@tauri-apps/api/event`

### Tauri Commands (Rust → TypeScript callable)

| Command | Description |
|---|---|
| `get_status` | Returns current `StateSnapshot` |
| `save_config` | Validates and persists settings |
| `start_reminders` | Starts timer with given config |
| `stop_reminders` | Stops timer, resets counter |
| `pause_reminders` | Pauses, preserves remaining time |
| `resume_reminders` | Resumes from pause |
| `snooze_reminder` | Delays next reminder by `snooze_minutes` |
| `reset_reminders` | Resets counter, stops timer |
| `reset_active_countdown` | Restarts the current interval without incrementing the count |
| `acknowledge_reminder` | Clears `WaitingAck` state |

### Tauri Events (Rust emits → TypeScript listens)

- `reminder-fired` — emitted each time a reminder notification fires
- `reminder-completed` — emitted when `max_count` is reached and timer auto-stops

## Key Conventions

**TypeScript interfaces mirror Rust structs exactly.** When changing `ReminderConfig` or `StateSnapshot` in `lib.rs`, update the corresponding TypeScript interfaces in `App.tsx` to match.

**All mutable Rust state lives behind `Arc<Mutex<AppState>>`** (`SharedState`). Commands receive it via Tauri's `State<'_, SharedState>`. Always lock, mutate, and drop before returning.

**Thread generation counter:** `AppState.thread_generation` is incremented on every start/stop cycle. The timer thread captures the generation at spawn time and exits when the current generation no longer matches — this prevents stale threads from firing after a restart.

**Debounced auto-save:** Form changes trigger a 500ms debounce before calling `save_config`. The timer is tracked in `autosaveTimerRef`. Don't call `save_config` directly on every keystroke.

**Settings persistence:** `tauri-plugin-store` writes to `settings.json` in the platform app data directory. Read on startup via `get_status` (which loads from store), write via `save_config`.

**Alert sound:** A synthesized 440→880 Hz tone via the Web Audio API in `playAlertSound()`. No audio files; no external dependencies. The initial sound plays from the `reminder-fired` event listener, and any 10-second repeat-until-action behavior is managed in React while the app is in `WaitingAck`.

**Validation is in Rust.** `save_config` returns `Result<StateSnapshot, String>`. The TypeScript side displays the error string if `Err` is returned.

## Windows OS Integration

All Win32 work is in `lib.rs`. Key patterns:

**WndProc subclassing** — `install_minimize_wndproc_hook` replaces the window's WndProc via `SetWindowLongPtrW(GWLP_WNDPROC)`. The custom proc intercepts `WM_SYSCOMMAND/SC_MINIMIZE` and hides to tray instead. Original proc pointer stored in `ORIGINAL_WNDPROC` static. WndProc callbacks can't take normal Rust parameters, so feature flags that the WndProc needs are stored in `AtomicBool` globals (`MINIMIZE_TO_TRAY`).

**System tray** — `TrayIconBuilder` creates the tray icon and context menu during `setup()`. Left-click and the "Show" menu item both call `restore_window_from_tray()`, which uses raw Win32 (`ShowWindow(SW_SHOW)` + `SetForegroundWindow`) to bypass Tauri's visibility cache (which is stale because WndProc hid the window via a raw `SW_HIDE` call). The `TrayIcon` is kept alive with `std::mem::forget`.

**Window raise without stealing focus** — `bring_window_to_front_without_focus_on_windows` uses `SetWindowPos(HWND_TOPMOST)` + `SetWindowPos(HWND_NOTOPMOST)` with `SWP_NOACTIVATE` to flash the window to the top of the Z-order without activating it.

**Always-on-top while waiting** — When `always_on_top` config is enabled and the app enters `WaitingAck`, `SetWindowPos(HWND_TOPMOST)` pins the window. `SetWindowPos(HWND_NOTOPMOST)` releases it on acknowledge/snooze.

**Taskbar flash** — `flash_window_taskbar_windows` calls `FlashWindowEx` directly, bypassing tao's `request_user_attention` which has an early-return bug when the window is already active.

**Virtual desktop auto-move** — `move_to_current_virtual_desktop_main_thread` uses the Windows COM `IVirtualDesktopManager` API to move the window to whichever virtual desktop is currently active before raising it.

**Wake lock** — `activate_wake_lock` calls `SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED | ES_CONTINUOUS)` to prevent sleep while a reminder session is active. `deactivate_wake_lock` calls `SetThreadExecutionState(ES_CONTINUOUS)` to release it.

## Tech Stack

| Layer | Technology |
|---|---|
| UI | React 19.x + TypeScript 6.0 |
| Build | Vite 8.0 |
| Desktop shell | Tauri 2.10 |
| Rust crate | `water_reminder_lib` (edition 2024) |
| Notifications | `tauri-plugin-notification` 2.x |
| Persistence | `tauri-plugin-store` 2.x |

## MCP Servers

A workspace-level [Playwright MCP server](https://github.com/microsoft/playwright-mcp) is configured in `.vscode/mcp.json`. When enabled in VS Code, it gives Copilot browser automation tools (navigate, click, screenshot, etc.) useful for inspecting or testing the app's web UI.

## Release Build Profile

The Cargo release profile uses `opt-level = "s"`, `lto = true`, `codegen-units = 1`, and `strip = true` — optimized for binary size. Avoid adding dependencies that significantly inflate binary size without good reason.


## Caveman
Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.