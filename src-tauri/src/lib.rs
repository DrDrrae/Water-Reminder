// lib.rs – core application logic for the Water Reminder Tauri app.
//
// Architecture overview
// ─────────────────────
// • `AppState`        – all mutable runtime data, protected by a `Mutex`.
// • `SharedState`     – type alias for `Arc<Mutex<AppState>>`, passed to
//                       every command and the timer thread.
// • Timer thread      – a background `std::thread` that wakes every 100 ms,
//                       checks whether a reminder should fire, and sends a
//                       desktop notification if so.  A "generation counter"
//                       (`thread_generation` field) ensures that if the user
//                       stops-then-starts rapidly, any old thread detects the
//                       mismatch and exits without firing a stale reminder.
// • Tauri commands    – invoked from the TypeScript front-end via
//                       `invoke(...)`.  They mutate `AppState` behind the
//                       mutex, then return a serialisable `StateSnapshot`.
// • Tauri events      – emitted from the timer thread back to the frontend:
//                       `reminder-fired`     → payload: current reminder count
//                       `reminder-completed` → payload: final reminder count
// • Settings persistence – `tauri-plugin-store` writes the user's config to a
//                       JSON file in the app's data directory so that settings
//                       survive application restarts.

use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_store::StoreExt;

// ── Type alias ───────────────────────────────────────────────────────────────

/// Convenience alias used throughout the module.
pub type SharedState = Arc<Mutex<AppState>>;

/// Name of the store file written to the app's data directory.
const STORE_FILE: &str = "settings.json";

/// Key under which the `ReminderConfig` is stored inside the JSON file.
const STORE_KEY_CONFIG: &str = "config";

// ── Data structures ──────────────────────────────────────────────────────────

/// The possible states of the reminder timer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReminderStatus {
    Stopped,
    Running,
    Paused,
    /// A reminder has fired and the app is waiting for the user to acknowledge
    /// it before the next interval begins.  Only used when
    /// `ReminderConfig::require_acknowledgment` is `true`.
    WaitingAck,
}

/// The user's visual theme preference for the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThemePreference {
    System,
    AlwaysLight,
    AlwaysDark,
}

/// User-configurable parameters for the reminder timer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderConfig {
    /// How often to fire a reminder, in minutes.
    pub interval_minutes: u32,
    /// Maximum number of reminders before auto-stopping.
    /// `None` means the timer runs indefinitely.
    pub max_count: Option<u32>,
    /// Which visual theme the frontend should use.
    #[serde(default = "default_theme_preference")]
    pub theme_preference: ThemePreference,
    /// How long to delay the next reminder when the user clicks "Snooze",
    /// in minutes.
    pub snooze_minutes: u32,
    /// When `true`, a fresh reminder session starts automatically on launch.
    #[serde(default)]
    pub auto_start: bool,
    /// When `true`, the timer pauses after each reminder fires and waits for
    /// the user to acknowledge before scheduling the next interval.
    #[serde(default = "serde_default_true")]
    pub require_acknowledgment: bool,
    /// When `true`, an alert sound is played in the frontend when a reminder
    /// fires.
    #[serde(default = "serde_default_true")]
    pub play_sound: bool,
    /// When `true`, the frontend keeps replaying the alert sound every
    /// 10 seconds while a reminder is waiting for acknowledgment or snooze.
    #[serde(default = "serde_default_true")]
    pub repeat_sound_until_action: bool,
    /// When `true`, the application window is brought to the foreground
    /// whenever a reminder fires.
    #[serde(default = "serde_default_true")]
    pub focus_window: bool,
    /// When `true`, the taskbar / dock icon flashes to signal a pending
    /// reminder.
    #[serde(default = "serde_default_true")]
    pub flash_taskbar: bool,
}

impl Default for ReminderConfig {
    fn default() -> Self {
        Self {
            interval_minutes: 60,
            max_count: None,
            theme_preference: ThemePreference::System,
            snooze_minutes: 5,
            auto_start: false,
            require_acknowledgment: true,
            play_sound: true,
            repeat_sound_until_action: true,
            focus_window: true,
            flash_taskbar: true,
        }
    }
}

/// Used as the serde `default` function for `bool` fields that should default
/// to `true`.  (`serde(default)` alone would give `false` for booleans.)
fn serde_default_true() -> bool {
    true
}

fn default_theme_preference() -> ThemePreference {
    ThemePreference::System
}

/// All mutable runtime state, stored behind a `Mutex`.
pub struct AppState {
    pub status: ReminderStatus,
    pub config: ReminderConfig,
    /// How many reminders have been fired in the current session.
    /// Resets to zero whenever the timer is stopped or the app is restarted.
    /// Only a Pause preserves the count (so the session can be resumed).
    pub reminder_count: u32,
    /// Absolute instant at which the next reminder should fire.
    /// `None` when the timer is stopped or paused.
    pub next_fire_at: Option<Instant>,
    /// Remaining time that was saved when the timer was paused.
    /// Used to resume from exactly where we left off.
    pub remaining_when_paused: Option<Duration>,
    /// Incremented every time a new timer thread is spawned.
    /// The timer thread compares its captured generation to this value and
    /// exits immediately if they differ, preventing stale threads from
    /// firing extra reminders.
    pub thread_generation: u64,
}

impl AppState {
    fn new() -> Self {
        Self {
            status: ReminderStatus::Stopped,
            // Config starts with defaults; the setup hook overwrites this with
            // any previously saved settings before the first command runs.
            config: ReminderConfig::default(),
            // Count always starts at zero on a fresh launch.
            reminder_count: 0,
            next_fire_at: None,
            remaining_when_paused: None,
            thread_generation: 0,
        }
    }
}

/// A serialisable snapshot of `AppState`, returned by all commands.
#[derive(Debug, Serialize, Deserialize)]
pub struct StateSnapshot {
    pub status: ReminderStatus,
    pub config: ReminderConfig,
    pub reminder_count: u32,
    /// Seconds until the next reminder fires.
    /// `None` when the timer is stopped or paused.
    pub seconds_until_next: Option<u64>,
}

/// Build a `StateSnapshot` from an `AppState` reference.
fn snapshot(state: &AppState) -> StateSnapshot {
    let seconds_until_next = state.next_fire_at.and_then(|t| {
        // `checked_duration_since` returns `None` if the instant is in the past,
        // which is fine – the timer thread will fire on the next loop tick.
        t.checked_duration_since(Instant::now())
            .map(|d| d.as_secs())
    });

    StateSnapshot {
        status: state.status.clone(),
        config: state.config.clone(),
        reminder_count: state.reminder_count,
        seconds_until_next,
    }
}

// ── Input validation helpers ──────────────────────────────────────────────────

/// Validate that a `ReminderConfig` contains sensible values.
fn validate_config(config: &ReminderConfig) -> Result<(), String> {
    if config.interval_minutes == 0 {
        return Err("Interval must be at least 1 minute.".into());
    }
    if config.interval_minutes > 1440 {
        return Err("Interval cannot exceed 1440 minutes (24 hours).".into());
    }
    if config.snooze_minutes == 0 {
        return Err("Snooze duration must be at least 1 minute.".into());
    }
    if config.snooze_minutes > 60 {
        return Err("Snooze duration cannot exceed 60 minutes.".into());
    }
    if let Some(max) = config.max_count {
        if max == 0 {
            return Err("Maximum reminder count must be at least 1.".into());
        }
    }
    Ok(())
}

// ── Persistence helpers ───────────────────────────────────────────────────────

/// Persist `config` to the on-disk store.
///
/// Errors are logged but not propagated so that a failed write never prevents
/// the user from continuing to use the app.
fn persist_config(app_handle: &AppHandle, config: &ReminderConfig) {
    match app_handle.store(STORE_FILE) {
        Ok(store) => {
            match serde_json::to_value(config) {
                Ok(value) => {
                    store.set(STORE_KEY_CONFIG, value);
                    if let Err(e) = store.save() {
                        eprintln!("[water-reminder] Failed to save config: {e}");
                    }
                }
                Err(e) => eprintln!("[water-reminder] Failed to serialise config: {e}"),
            }
        }
        Err(e) => eprintln!("[water-reminder] Failed to open store: {e}"),
    }
}

/// Try to load a previously saved `ReminderConfig` from the on-disk store.
/// Returns `None` if no config has been saved yet or if it cannot be parsed.
fn load_config(app_handle: &AppHandle) -> Option<ReminderConfig> {
    let store = app_handle.store(STORE_FILE).ok()?;
    let value = store.get(STORE_KEY_CONFIG)?;
    serde_json::from_value::<ReminderConfig>(value).ok()
}

// ── Tauri commands ────────────────────────────────────────────────────────────
//
// Each command receives the shared state via Tauri's dependency-injection
// system (`State<'_, SharedState>`).  Commands return `Result<StateSnapshot,
// String>`; Tauri serialises both variants for the TypeScript caller.

/// Save the user's settings to disk and update the in-memory config.
///
/// Called automatically from the front-end whenever a settings field is
/// changed so that preferences persist across application restarts.
#[tauri::command]
fn save_config(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
    config: ReminderConfig,
) -> Result<StateSnapshot, String> {
    // Validate before touching any state or writing to disk.
    validate_config(&config)?;

    let mut s = state.lock().map_err(|e| e.to_string())?;
    // Update the in-memory config so `get_status` reflects the latest settings
    // even before the user presses Start.
    s.config = config.clone();
    let snap = snapshot(&s);
    drop(s); // Release the lock before I/O.

    // Write to disk (errors are logged, not propagated).
    persist_config(&app_handle, &config);

    Ok(snap)
}

/// Start the reminder timer with the given configuration.
///
/// Returns an error if the timer is already running or if the configuration
/// is invalid.
#[tauri::command]
fn start_reminders(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
    config: ReminderConfig,
) -> Result<StateSnapshot, String> {
    // Validate user-supplied config before touching any state.
    validate_config(&config)?;

    let mut s = state.lock().map_err(|e| e.to_string())?;

    if s.status == ReminderStatus::Running {
        return Err("Timer is already running. Stop or pause it first.".into());
    }
    if s.status == ReminderStatus::Paused {
        return Err("Timer is paused. Resume or stop it first.".into());
    }

    // Apply new configuration and reset the counter for a fresh session.
    s.config = config.clone();
    s.status = ReminderStatus::Running;
    s.reminder_count = 0;
    s.remaining_when_paused = None;

    // Schedule the first reminder.
    s.next_fire_at = Some(
        Instant::now() + Duration::from_secs(s.config.interval_minutes as u64 * 60),
    );

    // Bump the generation counter so any lingering old thread exits.
    s.thread_generation += 1;
    let my_gen = s.thread_generation;

    let snap = snapshot(&s);
    drop(s); // Release the lock before spawning the thread.

    // Also persist the config that was just used to start a session.
    persist_config(&app_handle, &config);

    spawn_timer_thread(Arc::clone(&*state), app_handle, my_gen);

    Ok(snap)
}

/// Stop the reminder timer.
///
/// The reminder count is reset to zero so the next session begins fresh.
/// (Only a Pause preserves the count so the session can be resumed.)
#[tauri::command]
fn stop_reminders(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
) -> Result<StateSnapshot, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.status = ReminderStatus::Stopped;
    s.next_fire_at = None;
    s.remaining_when_paused = None;
    // Reset the count: the requirement is that stopping resets the loop counter
    // so the next Start begins from reminder #1.
    s.reminder_count = 0;
    // Bump generation so the timer thread exits on its next iteration.
    s.thread_generation += 1;
    let snap = snapshot(&s);
    drop(s);
    // Clear any pending taskbar-flash / user-attention request.
    stop_window_attention(&app_handle);
    Ok(snap)
}

/// Pause the timer.  The remaining time until the next reminder is saved so
/// that `resume_reminders` can pick up exactly where it left off.
///
/// The reminder count is intentionally preserved on pause so that resuming
/// continues the session from where it was interrupted.
#[tauri::command]
fn pause_reminders(state: State<'_, SharedState>) -> Result<StateSnapshot, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;

    if s.status != ReminderStatus::Running {
        return Err("Timer is not running.".into());
    }

    // Capture how much time was left on the current interval.
    s.remaining_when_paused = s.next_fire_at.map(|t| {
        t.checked_duration_since(Instant::now())
            .unwrap_or(Duration::ZERO)
    });
    s.status = ReminderStatus::Paused;
    s.next_fire_at = None;
    // Bump generation so the timer thread sees Paused and checks generation.
    s.thread_generation += 1;

    Ok(snapshot(&s))
}

/// Resume the timer after a pause, restoring the remaining countdown.
#[tauri::command]
fn resume_reminders(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
) -> Result<StateSnapshot, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;

    if s.status != ReminderStatus::Paused {
        return Err("Timer is not paused.".into());
    }

    // Restore the remaining time that was saved during `pause_reminders`.
    let remaining = s
        .remaining_when_paused
        .unwrap_or_else(|| Duration::from_secs(s.config.interval_minutes as u64 * 60));

    s.next_fire_at = Some(Instant::now() + remaining);
    s.remaining_when_paused = None;
    s.status = ReminderStatus::Running;

    // Bump generation and spawn a fresh timer thread.
    s.thread_generation += 1;
    let my_gen = s.thread_generation;

    let snap = snapshot(&s);
    drop(s);

    spawn_timer_thread(Arc::clone(&*state), app_handle, my_gen);

    Ok(snap)
}

/// Reset the reminder count to zero and stop the timer.
#[tauri::command]
fn reset_reminders(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
) -> Result<StateSnapshot, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.status = ReminderStatus::Stopped;
    s.reminder_count = 0;
    s.next_fire_at = None;
    s.remaining_when_paused = None;
    // Bump generation so the timer thread exits.
    s.thread_generation += 1;
    let snap = snapshot(&s);
    drop(s);
    // Clear any pending taskbar-flash / user-attention request.
    stop_window_attention(&app_handle);
    Ok(snap)
}

/// Delay the next reminder by `snooze_minutes` from now.
///
/// Works whether the timer is Running, Paused, or WaitingAck.  The current
/// timer thread (if any) is always replaced with a fresh one so that it picks
/// up the updated fire time correctly.
#[tauri::command]
fn snooze_reminder(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
) -> Result<StateSnapshot, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;

    if s.status == ReminderStatus::Stopped {
        return Err("No active reminder to snooze.".into());
    }

    let snooze_duration = Duration::from_secs(s.config.snooze_minutes as u64 * 60);
    s.next_fire_at = Some(Instant::now() + snooze_duration);
    s.remaining_when_paused = None;
    s.status = ReminderStatus::Running;

    // Always bump the generation so that any currently-running thread (whether
    // it was in Running, Paused, or WaitingAck) exits cleanly, then spawn a
    // fresh thread that will observe the new fire time.
    s.thread_generation += 1;
    let my_gen = s.thread_generation;

    let snap = snapshot(&s);
    drop(s);

    // Clear any pending taskbar-flash / user-attention request.
    stop_window_attention(&app_handle);

    spawn_timer_thread(Arc::clone(&*state), app_handle, my_gen);

    Ok(snap)
}

/// Return the current state without mutating anything.  Called by the
/// front-end every second to keep the countdown display in sync.
#[tauri::command]
fn get_status(state: State<'_, SharedState>) -> Result<StateSnapshot, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(snapshot(&s))
}

/// Acknowledge the current reminder and start the next full interval.
///
/// Only valid when status is `WaitingAck`.  The existing timer thread (which
/// has been looping idle since the reminder fired) picks up the new fire time
/// without needing to be replaced – so the generation counter is intentionally
/// **not** bumped here.
#[tauri::command]
fn acknowledge_reminder(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
) -> Result<StateSnapshot, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;

    if s.status != ReminderStatus::WaitingAck {
        return Err("No reminder is currently waiting for acknowledgment.".into());
    }

    // Schedule the next full interval and transition back to Running.
    // The timer thread is still looping with the current generation; it will
    // detect the Running status and new fire time on its next iteration.
    s.next_fire_at = Some(
        Instant::now() + Duration::from_secs(s.config.interval_minutes as u64 * 60),
    );
    s.status = ReminderStatus::Running;

    let snap = snapshot(&s);
    drop(s);

    // Clear any pending taskbar-flash / user-attention request.
    stop_window_attention(&app_handle);

    Ok(snap)
}

// ── Timer thread ──────────────────────────────────────────────────────────────

/// Spawn a background thread that drives the reminder schedule.
///
/// The thread polls at 100 ms intervals.  On each wake it:
/// 1. Compares its `my_gen` against `state.thread_generation`; if they
///    differ the thread exits silently (a newer session has taken over).
/// 2. If the status is `Stopped`, exits.
/// 3. If the status is `Paused` or `WaitingAck`, sleeps and retries.
/// 4. If the status is `Running` and the fire time has passed:
///    a. Sends a desktop notification.
///    b. Increments the reminder count.
///    c. Optionally brings the window to the front / flashes the taskbar.
///    d. Emits the `reminder-fired` event to the frontend.
///    e. If `max_count` is reached, sets status to `Stopped` and emits
///       `reminder-completed`.
///    f. If `require_acknowledgment` is set, transitions to `WaitingAck`.
///    g. Otherwise schedules the next fire time immediately.
fn spawn_timer_thread(state: SharedState, app_handle: AppHandle, my_gen: u64) {
    thread::spawn(move || {
        loop {
            // Sleep for a short interval to avoid busy-waiting.
            thread::sleep(Duration::from_millis(100));

            // ── Determine what to do next (hold the lock briefly) ─────────
            // (new_count, is_last, focus_window, flash_taskbar)
            let fire_info: Option<(u32, bool, bool, bool)>;

            {
                let mut s = match state.lock() {
                    Ok(g) => g,
                    // Mutex poisoned – another thread panicked; safest to exit.
                    Err(_) => break,
                };

                // Generation check: a newer session has superseded this thread.
                if s.thread_generation != my_gen {
                    break;
                }

                match s.status {
                    ReminderStatus::Stopped => break, // Timer was stopped; exit cleanly.
                    // Both Paused and WaitingAck idle here – a different command
                    // will transition the status back to Running when appropriate.
                    ReminderStatus::Paused | ReminderStatus::WaitingAck => {
                        fire_info = None;
                    }
                    ReminderStatus::Running => {
                        // Check whether the fire time has arrived.
                        let should_fire = s
                            .next_fire_at
                            .map(|t| Instant::now() >= t)
                            .unwrap_or(false);

                        if !should_fire {
                            fire_info = None;
                        } else {
                            // ── It's time to fire! ─────────────────────────────────
                            s.reminder_count += 1;
                            let new_count = s.reminder_count;

                            // Check if this is the final reminder in a limited session.
                            let is_last = s
                                .config
                                .max_count
                                .map(|max| new_count >= max)
                                .unwrap_or(false);

                            if is_last {
                                // Auto-stop the timer.  The count is intentionally NOT
                                // reset here so the user can see "X/X reminders
                                // completed" in the UI.
                                s.status = ReminderStatus::Stopped;
                                s.next_fire_at = None;
                            } else if s.config.require_acknowledgment {
                                // Wait for the user to confirm they drank water before
                                // the next interval begins.
                                s.status = ReminderStatus::WaitingAck;
                                s.next_fire_at = None;
                            } else {
                                // Schedule the next reminder immediately.
                                s.next_fire_at = Some(
                                    Instant::now()
                                        + Duration::from_secs(
                                            s.config.interval_minutes as u64 * 60,
                                        ),
                                );
                            }

                            fire_info = Some((
                                new_count,
                                is_last,
                                s.config.focus_window,
                                s.config.flash_taskbar,
                            ));
                        }
                    }
                }
                // Lock is released here (end of the block).
            }

            // ── Send notification & emit events (lock NOT held) ───────────
            if let Some((count, is_last, focus_window, flash_taskbar)) = fire_info {
                // Send desktop notification.
                send_notification(&app_handle);

                // Optionally bring the window to the front.
                if focus_window {
                    bring_window_to_front(&app_handle);
                }

                // Optionally flash the taskbar / dock icon.
                if flash_taskbar {
                    flash_window_taskbar(&app_handle);
                }

                // Notify the frontend that a reminder fired.
                let _ = app_handle.emit("reminder-fired", count);

                if is_last {
                    // Notify the frontend that the session has completed.
                    let _ = app_handle.emit("reminder-completed", count);
                    break; // Exit the timer thread.
                }
            }
        }
    });
}

/// Send a desktop notification using `tauri-plugin-notification`.
/// Errors are logged to stderr but not propagated – a missed notification
/// should not crash the application.
fn send_notification(app_handle: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;

    if let Err(e) = app_handle
        .notification()
        .builder()
        .title("💧 Water Reminder")
        .body("Time to drink some water! Stay hydrated!")
        .show()
    {
        eprintln!("[water-reminder] Failed to send notification: {e}");
    }
}

/// Surface the main application window so it is visible to the user.
///
/// On Windows we try to raise the window without stealing focus. Other
/// platforms keep the existing focus-based behavior for now.
fn bring_window_to_front(app_handle: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        bring_window_to_front_without_focus_on_windows(app_handle);
        return;
    }

    #[cfg(not(target_os = "windows"))]
    if let Some(win) = app_handle.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[cfg(target_os = "windows")]
fn bring_window_to_front_without_focus_on_windows(app_handle: &AppHandle) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            HWND_NOTOPMOST, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE,
            SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE, SetWindowPos, ShowWindow,
        },
    };

    let Some(win) = app_handle.get_webview_window("main") else {
        return;
    };

    let window_handle = match win.window_handle() {
        Ok(handle) => handle,
        Err(e) => {
            eprintln!("[water-reminder] Failed to get native window handle: {e}");
            let _ = win.show();
            return;
        }
    };

    let hwnd = match window_handle.as_raw() {
        RawWindowHandle::Win32(handle) => handle.hwnd.get() as HWND,
        _ => {
            eprintln!("[water-reminder] Unexpected non-Win32 window handle on Windows.");
            let _ = win.show();
            return;
        }
    };

    unsafe {
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);

        let flags =
            SWP_ASYNCWINDOWPOS | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW;

        if SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags) == 0 {
            eprintln!("[water-reminder] Failed to raise reminder window to topmost.");
            return;
        }

        if SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags) == 0 {
            eprintln!("[water-reminder] Failed to restore reminder window to non-topmost.");
        }
    }
}

/// Ask the OS to flash / bounce the taskbar or dock icon to attract the user's
/// attention.  Errors are logged but not propagated.
fn flash_window_taskbar(app_handle: &AppHandle) {
    use tauri_runtime::UserAttentionType;
    if let Some(win) = app_handle.get_webview_window("main") {
        let _ = win.request_user_attention(Some(UserAttentionType::Critical));
    }
}

/// Stop any pending taskbar flash / dock-bounce that was started by a
/// previous call to `flash_window_taskbar`.
fn stop_window_attention(app_handle: &AppHandle) {
    if let Some(win) = app_handle.get_webview_window("main") {
        let _ = win.request_user_attention(None);
    }
}

// ── Application entry point ───────────────────────────────────────────────────

/// Called from `main.rs`.  Builds the Tauri application, registers plugins
/// and commands, loads any previously saved settings, optionally auto-starts
/// reminders, then runs the event loop.
pub fn run() {
    tauri::Builder::default()
        // Register the native dialog plugin.
        .plugin(tauri_plugin_dialog::init())
        // Register the desktop notification plugin.
        .plugin(tauri_plugin_notification::init())
        // Register the store plugin for persistent settings.
        .plugin(tauri_plugin_store::Builder::default().build())
        // Inject shared state so every command can access it.
        .manage(Arc::new(Mutex::new(AppState::new())) as SharedState)
        // Setup hook: runs once after the app is initialised but before any
        // window is shown.  We use it to load the persisted config so that
        // `get_status` returns the correct settings from the very first call,
        // and optionally auto-start a fresh reminder session.
        .setup(|app| {
            if let Some(saved_config) = load_config(app.handle()) {
                // Validate the stored config before applying it; if it is
                // somehow corrupt we simply keep the built-in defaults.
                if validate_config(&saved_config).is_ok() {
                    let mut auto_start_generation = None;

                    if let Ok(mut s) = app.state::<SharedState>().lock() {
                        s.config = saved_config;

                        if s.config.auto_start {
                            s.status = ReminderStatus::Running;
                            s.reminder_count = 0;
                            s.remaining_when_paused = None;
                            s.next_fire_at = Some(
                                Instant::now()
                                    + Duration::from_secs(s.config.interval_minutes as u64 * 60),
                            );
                            s.thread_generation += 1;
                            auto_start_generation = Some(s.thread_generation);
                        }
                    }

                    if let Some(my_gen) = auto_start_generation {
                        let shared_state = app.state::<SharedState>();
                        spawn_timer_thread(Arc::clone(&*shared_state), app.handle().clone(), my_gen);
                    }
                }
            }
            Ok(())
        })
        // Register all IPC commands exposed to the frontend.
        .invoke_handler(tauri::generate_handler![
            save_config,
            start_reminders,
            stop_reminders,
            pause_reminders,
            resume_reminders,
            reset_reminders,
            snooze_reminder,
            acknowledge_reminder,
            get_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
