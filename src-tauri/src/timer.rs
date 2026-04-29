// timer.rs — background timer thread and desktop notification helper.

use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::platform;
use crate::state::{ReminderStatus, SharedState, interval_duration};

/// Spawn a background thread that drives the reminder schedule.
///
/// The thread polls at 100 ms intervals.  On each wake it:
/// 1. Compares its `my_gen` against `state.thread_generation`; if they differ
///    the thread exits silently (a newer session has taken over).
/// 2. If the status is `Stopped`, exits.
/// 3. If the status is `Paused` or `WaitingAck`, sleeps and retries.
/// 4. If the status is `Running` and the fire time has passed, fires a
///    reminder: sends a desktop notification, increments the count, optionally
///    focuses the window / flashes the taskbar, emits events, and schedules the
///    next interval (or stops if `max_count` is reached).
pub fn spawn_timer_thread(state: SharedState, app_handle: AppHandle, my_gen: u64) {
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(100));

            // (new_count, is_last, focus_window, flash_taskbar, release_wake_lock)
            let fire_info: Option<(u32, bool, bool, bool, bool)>;

            {
                let mut s = match state.lock() {
                    Ok(g) => g,
                    // Mutex poisoned — another thread panicked; safest to exit.
                    Err(_) => break,
                };

                // Generation check: a newer session has superseded this thread.
                if s.thread_generation != my_gen {
                    break;
                }

                match s.status {
                    ReminderStatus::Stopped => break,
                    ReminderStatus::Paused | ReminderStatus::WaitingAck => {
                        fire_info = None;
                    }
                    ReminderStatus::Running => {
                        let should_fire =
                            s.next_fire_at.map(|t| Instant::now() >= t).unwrap_or(false);

                        if !should_fire {
                            fire_info = None;
                        } else {
                            s.reminder_count += 1;
                            let new_count = s.reminder_count;

                            let is_last = s
                                .config
                                .max_count
                                .map(|max| new_count >= max)
                                .unwrap_or(false);

                            if is_last {
                                s.status = ReminderStatus::Stopped;
                                s.next_fire_at = None;
                            } else if s.config.require_acknowledgment {
                                s.status = ReminderStatus::WaitingAck;
                                s.next_fire_at = None;
                            } else {
                                s.next_fire_at = Some(Instant::now() + interval_duration(&s.config));
                            }

                            fire_info = Some((
                                new_count,
                                is_last,
                                s.config.focus_window,
                                s.config.flash_taskbar,
                                is_last && s.config.keep_awake,
                            ));
                        }
                    }
                }
            }

            if let Some((count, is_last, focus_window, flash_taskbar, release_wake_lock)) =
                fire_info
            {
                send_notification(&app_handle);

                if focus_window {
                    platform::bring_window_to_front(&app_handle);
                }

                if flash_taskbar {
                    platform::flash_window_taskbar(&app_handle);
                }

                let _ = app_handle.emit("reminder-fired", count);

                if is_last {
                    let _ = app_handle.emit("reminder-completed", count);
                    if release_wake_lock {
                        platform::deactivate_wake_lock(&app_handle);
                    }
                    break;
                }
            }
        }
    });
}

/// Send a desktop notification using `tauri-plugin-notification`.
/// Errors are logged to stderr but not propagated — a missed notification
/// should not crash the application.
pub fn send_notification(app_handle: &AppHandle) {
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
