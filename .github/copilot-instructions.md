# Copilot Instructions

## Project Overview

Water Reminder is a Tauri v2 desktop app that sends hydration reminders at configurable intervals. It has a React/TypeScript frontend and a Rust backend (`src-tauri/src/lib.rs`).

## Commands

```bash
npm run tauri dev      # Dev mode with hot reload (starts Vite + Tauri shell)
npm run tauri build    # Release build → src-tauri/target/release/bundle/
npm run build          # TypeScript compile + Vite bundle only (no Tauri shell)
npm run dev            # Vite dev server only (no Tauri shell, UI only)
```

There are no test or lint scripts defined.

## Architecture

**Frontend** (`src/`): Single React component (`App.tsx`, ~650 lines) with local state, polling, and event listeners. No state management library.

**Backend** (`src-tauri/src/lib.rs`, ~700 lines): Rust library crate (`water_reminder_lib`). All timer logic, OS integration, and state live here. The `main.rs` entry point just calls `water_reminder_lib::run()`.

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

## Tech Stack

| Layer | Technology |
|---|---|
| UI | React 18.3 + TypeScript 5.8 |
| Build | Vite 6.3 |
| Desktop shell | Tauri 2.10 |
| Rust crate | `water_reminder_lib` (edition 2021) |
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