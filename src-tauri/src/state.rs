// state.rs — all shared data types, validation, and state helpers.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

// ── Type alias ────────────────────────────────────────────────────────────────

/// Convenience alias used throughout the crate.
pub type SharedState = Arc<Mutex<AppState>>;

// ── Enumerations ──────────────────────────────────────────────────────────────

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

// ── Configuration ─────────────────────────────────────────────────────────────

/// User-configurable parameters for the reminder timer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderConfig {
    /// How often to fire a reminder, in minutes.
    pub interval_minutes: u32,
    /// Maximum number of reminders before auto-stopping.  `None` = infinite.
    pub max_count: Option<u32>,
    /// Which visual theme the frontend should use.
    #[serde(default = "default_theme_preference")]
    pub theme_preference: ThemePreference,
    /// How long to delay the next reminder when the user clicks "Snooze", in minutes.
    pub snooze_minutes: u32,
    /// When `true`, a fresh reminder session starts automatically on launch.
    #[serde(default)]
    pub auto_start: bool,
    /// When `true`, the timer pauses after each reminder and waits for acknowledgment.
    #[serde(default = "serde_default_true")]
    pub require_acknowledgment: bool,
    /// When `true`, an alert sound is played in the frontend when a reminder fires.
    #[serde(default = "serde_default_true")]
    pub play_sound: bool,
    /// When `true`, the alert sound repeats every 10 seconds while waiting for action.
    #[serde(default = "serde_default_true")]
    pub repeat_sound_until_action: bool,
    /// When `true`, the window is brought to the foreground when a reminder fires.
    #[serde(default = "serde_default_true")]
    pub focus_window: bool,
    /// When `true`, the taskbar icon flashes to signal a pending reminder.
    #[serde(default = "serde_default_true")]
    pub flash_taskbar: bool,
    /// When `true`, the window minimizes when starting, resuming, snoozing, or acknowledging.
    #[serde(default)]
    pub minimize_on_acknowledge: bool,
    /// When `true`, the window stays always-on-top while in `WaitingAck`.
    /// Only has effect when `focus_window` is also `true`.
    #[serde(default)]
    pub always_on_top_while_waiting: bool,
    /// When `true`, the system is prevented from sleeping while a session is active.
    /// Windows only; no-op on other platforms.
    #[serde(default)]
    pub keep_awake: bool,
    /// When `true`, minimizing hides to the system tray instead of the taskbar.
    /// Windows only.
    #[serde(default)]
    pub minimize_to_tray: bool,
    /// When `true`, the timer auto-pauses on session lock and resumes on unlock.
    /// Windows only.
    #[serde(default)]
    pub pause_on_lock: bool,
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
            minimize_on_acknowledge: false,
            always_on_top_while_waiting: false,
            keep_awake: false,
            minimize_to_tray: false,
            pause_on_lock: false,
        }
    }
}

fn serde_default_true() -> bool {
    true
}

fn default_theme_preference() -> ThemePreference {
    ThemePreference::System
}

// ── Runtime state ─────────────────────────────────────────────────────────────

/// All mutable runtime state, stored behind a `Mutex`.
pub struct AppState {
    pub status: ReminderStatus,
    pub config: ReminderConfig,
    /// How many reminders have fired in the current session.
    pub reminder_count: u32,
    /// Absolute instant at which the next reminder should fire.
    pub next_fire_at: Option<Instant>,
    /// Remaining time saved when the timer was paused, used to resume exactly.
    pub remaining_when_paused: Option<Duration>,
    /// Incremented on every start/stop cycle.  The timer thread compares its
    /// captured generation to this value and exits if they differ.
    pub thread_generation: u64,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            status: ReminderStatus::Stopped,
            config: ReminderConfig::default(),
            reminder_count: 0,
            next_fire_at: None,
            remaining_when_paused: None,
            thread_generation: 0,
        }
    }
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

/// A serialisable snapshot of `AppState`, returned by all commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateSnapshot {
    pub status: ReminderStatus,
    pub config: ReminderConfig,
    pub reminder_count: u32,
    /// Seconds until the next reminder fires.  `None` when stopped or paused.
    pub seconds_until_next: Option<u64>,
}

/// Build a `StateSnapshot` from an `AppState` reference.
pub fn snapshot(state: &AppState) -> StateSnapshot {
    let seconds_until_next = state.next_fire_at.and_then(|t| {
        t.checked_duration_since(Instant::now()).map(|d| d.as_secs())
    });
    StateSnapshot {
        status: state.status.clone(),
        config: state.config.clone(),
        reminder_count: state.reminder_count,
        seconds_until_next,
    }
}

// ── Validation ────────────────────────────────────────────────────────────────

/// Validate that a `ReminderConfig` contains sensible values.
pub fn validate_config(config: &ReminderConfig) -> Result<(), String> {
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Returns the `Duration` corresponding to one full reminder interval.
/// Centralises the `interval_minutes → Duration` conversion used in many places.
pub fn interval_duration(config: &ReminderConfig) -> Duration {
    Duration::from_secs(config.interval_minutes as u64 * 60)
}
