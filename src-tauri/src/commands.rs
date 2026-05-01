// commands.rs — all Tauri IPC commands exposed to the TypeScript frontend.
//
// Every command receives the shared state via Tauri's dependency injection
// (`State<'_, SharedState>`), mutates it behind the mutex, and returns a
// serialisable `StateSnapshot`.  The TypeScript caller receives either
// `Ok(snapshot)` or `Err(message)`.
//
// `stop_session_inner` deduplicates the identical logic shared by
// `stop_reminders` and `reset_reminders`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, State};

use crate::platform;
use crate::state::{
    ReminderConfig, ReminderStatus, SharedState, StateSnapshot, interval_duration,
    snapshot, validate_config,
};
use crate::store::{load_config, persist_config};
use crate::timer::spawn_timer_thread;

// ── Internal helper ───────────────────────────────────────────────────────────

/// Shared logic for both `stop_reminders` and `reset_reminders`.
/// Stops the timer, resets the counter, clears window attention, deactivates
/// the wake lock, and clears the auto-pause flag.
fn stop_session_inner(
    state: &State<'_, SharedState>,
    app_handle: &AppHandle,
) -> Result<StateSnapshot, String> {
    let (snap, was_keep_awake) = {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.status = ReminderStatus::Stopped;
        s.reminder_count = 0;
        s.next_fire_at = None;
        s.remaining_when_paused = None;
        s.thread_generation += 1;
        let was_keep_awake = s.config.keep_awake;
        (snapshot(&s), was_keep_awake)
    };

    platform::clear_auto_pause_flag();
    platform::stop_window_attention(app_handle);

    if was_keep_awake {
        platform::deactivate_wake_lock(app_handle);
    }

    Ok(snap)
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Return the current state without mutating anything.
/// Called by the frontend every second to keep the countdown display in sync.
#[tauri::command]
pub fn get_status(state: State<'_, SharedState>) -> Result<StateSnapshot, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(snapshot(&s))
}

/// Save the user's settings to disk and update the in-memory config.
///
/// Called automatically from the frontend whenever a settings field changes.
#[tauri::command]
pub fn save_config(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
    config: ReminderConfig,
) -> Result<StateSnapshot, String> {
    validate_config(&config)?;

    let (snap, active_session, resolve_waiting_ack, prev_keep_awake) = {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        let active_session = s.status != ReminderStatus::Stopped;
        let changed_timing = config.interval_minutes != s.config.interval_minutes
            || config.max_count != s.config.max_count
            || config.snooze_minutes != s.config.snooze_minutes;

        if active_session && changed_timing {
            return Err(
                "Stop the current reminder session to change the reminder interval, maximum reminders, or snooze duration."
                    .into(),
            );
        }

        let resolve_waiting_ack = s.status == ReminderStatus::WaitingAck
            && s.config.require_acknowledgment
            && !config.require_acknowledgment;

        let prev_keep_awake = s.config.keep_awake;

        s.config = config.clone();

        if resolve_waiting_ack {
            s.status = ReminderStatus::Running;
            s.next_fire_at = Some(Instant::now() + interval_duration(&s.config));
            s.remaining_when_paused = None;
        }

        (snapshot(&s), active_session, resolve_waiting_ack, prev_keep_awake)
    };

    if resolve_waiting_ack {
        platform::stop_window_attention(&app_handle);
    }

    if active_session {
        if config.keep_awake && !prev_keep_awake {
            let still_active = state
                .lock()
                .map(|s| s.status != ReminderStatus::Stopped)
                .unwrap_or(false);
            if still_active {
                platform::activate_wake_lock(&app_handle);
            }
        } else if !config.keep_awake && prev_keep_awake {
            platform::deactivate_wake_lock(&app_handle);
        }
    }

    persist_config(&app_handle, &config);
    platform::sync_minimize_to_tray_state(&app_handle, config.minimize_to_tray);
    platform::sync_pause_on_lock_state(config.pause_on_lock);

    Ok(snap)
}

/// Start the reminder timer with the given configuration.
/// Returns an error if the timer is already running or the config is invalid.
#[tauri::command]
pub fn start_reminders(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
    config: ReminderConfig,
) -> Result<StateSnapshot, String> {
    validate_config(&config)?;

    let (snap, my_gen, keep_awake, minimize) = {
        let mut s = state.lock().map_err(|e| e.to_string())?;

        if s.status == ReminderStatus::Running {
            return Err("Timer is already running. Stop or pause it first.".into());
        }
        if s.status == ReminderStatus::Paused {
            return Err("Timer is paused. Resume or stop it first.".into());
        }

        s.config = config.clone();
        s.status = ReminderStatus::Running;
        s.reminder_count = 0;
        s.remaining_when_paused = None;
        s.next_fire_at = Some(Instant::now() + interval_duration(&s.config));
        s.thread_generation += 1;
        let my_gen = s.thread_generation;

        (snapshot(&s), my_gen, s.config.keep_awake, s.config.minimize_on_acknowledge)
    };

    persist_config(&app_handle, &config);
    platform::sync_minimize_to_tray_state(&app_handle, config.minimize_to_tray);
    platform::sync_pause_on_lock_state(config.pause_on_lock);

    if keep_awake {
        platform::activate_wake_lock(&app_handle);
    }

    spawn_timer_thread(Arc::clone(&*state), app_handle.clone(), my_gen);

    if minimize {
        platform::minimize_window(&app_handle);
    }

    Ok(snap)
}

/// Stop the reminder timer and reset the count to zero.
#[tauri::command]
pub fn stop_reminders(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
) -> Result<StateSnapshot, String> {
    stop_session_inner(&state, &app_handle)
}

/// Reset the reminder count to zero and stop the timer.
/// Functionally identical to `stop_reminders`; exists as a separate command so
/// the frontend can distinguish intentional resets from stop actions.
#[tauri::command]
pub fn reset_reminders(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
) -> Result<StateSnapshot, String> {
    stop_session_inner(&state, &app_handle)
}

/// Pause the timer, preserving the remaining time so it can be resumed exactly.
#[tauri::command]
pub fn pause_reminders(state: State<'_, SharedState>) -> Result<StateSnapshot, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;

    if s.status != ReminderStatus::Running {
        return Err("Timer is not running.".into());
    }

    s.remaining_when_paused = s.next_fire_at.map(|t| {
        t.checked_duration_since(Instant::now())
            .unwrap_or(Duration::ZERO)
    });
    s.status = ReminderStatus::Paused;
    s.next_fire_at = None;
    s.thread_generation += 1;

    Ok(snapshot(&s))
}

/// Resume the timer after a pause, restoring the remaining countdown.
#[tauri::command]
pub fn resume_reminders(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
) -> Result<StateSnapshot, String> {
    let (snap, my_gen, minimize) = {
        let mut s = state.lock().map_err(|e| e.to_string())?;

        if s.status != ReminderStatus::Paused {
            return Err("Timer is not paused.".into());
        }

        let remaining = s
            .remaining_when_paused
            .unwrap_or_else(|| interval_duration(&s.config));

        s.next_fire_at = Some(Instant::now() + remaining);
        s.remaining_when_paused = None;
        s.status = ReminderStatus::Running;
        s.thread_generation += 1;
        let my_gen = s.thread_generation;

        (snapshot(&s), my_gen, s.config.minimize_on_acknowledge)
    };

    spawn_timer_thread(Arc::clone(&*state), app_handle.clone(), my_gen);

    if minimize {
        platform::minimize_window(&app_handle);
    }

    Ok(snap)
}

/// Delay the next reminder by `snooze_minutes` from now.
///
/// Works whether the timer is Running, Paused, or WaitingAck.
#[tauri::command]
pub fn snooze_reminder(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
) -> Result<StateSnapshot, String> {
    let (snap, my_gen, minimize) = {
        let mut s = state.lock().map_err(|e| e.to_string())?;

        if s.status == ReminderStatus::Stopped {
            return Err("No active reminder to snooze.".into());
        }

        let snooze_duration = Duration::from_secs(s.config.snooze_minutes as u64 * 60);
        s.next_fire_at = Some(Instant::now() + snooze_duration);
        s.remaining_when_paused = None;
        s.status = ReminderStatus::Running;
        s.thread_generation += 1;
        let my_gen = s.thread_generation;

        (snapshot(&s), my_gen, s.config.minimize_on_acknowledge)
    };

    platform::stop_window_attention(&app_handle);
    spawn_timer_thread(Arc::clone(&*state), app_handle.clone(), my_gen);

    if minimize {
        platform::minimize_window(&app_handle);
    }

    Ok(snap)
}

/// Restart the active countdown from the full configured interval.
/// Only valid while status is `Running`.
#[tauri::command]
pub fn reset_active_countdown(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
) -> Result<StateSnapshot, String> {
    let (snap, minimize) = {
        let mut s = state.lock().map_err(|e| e.to_string())?;

        if s.status != ReminderStatus::Running {
            return Err("Countdown can only be reset while reminders are running.".into());
        }

        s.next_fire_at = Some(Instant::now() + interval_duration(&s.config));
        s.remaining_when_paused = None;

        (snapshot(&s), s.config.minimize_on_acknowledge)
    };

    platform::stop_window_attention(&app_handle);

    if minimize {
        platform::minimize_window(&app_handle);
    }

    Ok(snap)
}

/// Acknowledge the current reminder and start the next full interval.
/// Only valid when status is `WaitingAck`.
///
/// The existing timer thread (which has been idling since the reminder fired)
/// picks up the new fire time without needing to be replaced, so the generation
/// counter is intentionally **not** bumped here.
#[tauri::command]
pub fn acknowledge_reminder(
    state: State<'_, SharedState>,
    app_handle: AppHandle,
) -> Result<StateSnapshot, String> {
    let (snap, minimize) = {
        let mut s = state.lock().map_err(|e| e.to_string())?;

        if s.status != ReminderStatus::WaitingAck {
            return Err("No reminder is currently waiting for acknowledgment.".into());
        }

        s.next_fire_at = Some(Instant::now() + interval_duration(&s.config));
        s.status = ReminderStatus::Running;

        (snapshot(&s), s.config.minimize_on_acknowledge)
    };

    if minimize {
        platform::minimize_window(&app_handle);
    }

    // Stop taskbar flash after minimizing so tray mode doesn't leave it visible.
    platform::stop_window_attention(&app_handle);

    Ok(snap)
}

// ── Setup helper ──────────────────────────────────────────────────────────────

/// Load the persisted config into `state` and return auto-start parameters.
/// Returns `(auto_start_generation, keep_awake, minimize_on_acknowledge)`.
pub fn apply_saved_config(state: &SharedState, app_handle: &AppHandle) -> (Option<u64>, bool, bool) {
    let Some(saved_config) = load_config(app_handle) else {
        return (None, false, false);
    };

    if validate_config(&saved_config).is_err() {
        return (None, false, false);
    }

    let mut s = match state.lock() {
        Ok(s) => s,
        Err(_) => return (None, false, false),
    };

    s.config = saved_config;

    if !s.config.auto_start {
        return (None, false, false);
    }

    s.status = ReminderStatus::Running;
    s.reminder_count = 0;
    s.remaining_when_paused = None;
    s.next_fire_at = Some(Instant::now() + interval_duration(&s.config));
    s.thread_generation += 1;

    let thread_gen = s.thread_generation;
    let keep_awake = s.config.keep_awake;
    let minimize = s.config.minimize_on_acknowledge;

    (Some(thread_gen), keep_awake, minimize)
}
