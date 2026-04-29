// types.ts — TypeScript interfaces and types that mirror the Rust backend structs.

/** The user's visual theme preference. */
export type ThemePreference = "System" | "AlwaysLight" | "AlwaysDark";

/** The resolved theme applied to the DOM. */
export type EffectiveTheme = "light" | "dark";

/** Possible states of the reminder timer. */
export type ReminderStatus = "Stopped" | "Running" | "Paused" | "WaitingAck";

/** Configuration settings for the reminder timer. */
export interface ReminderConfig {
  interval_minutes: number;
  max_count: number | null;
  theme_preference: ThemePreference;
  snooze_minutes: number;
  auto_start: boolean;
  require_acknowledgment: boolean;
  play_sound: boolean;
  repeat_sound_until_action: boolean;
  focus_window: boolean;
  flash_taskbar: boolean;
  minimize_on_acknowledge: boolean;
  /** Only has effect when focus_window is also true. */
  always_on_top_while_waiting: boolean;
  /** Windows only; no-op on other platforms. */
  keep_awake: boolean;
  /** Windows only. */
  minimize_to_tray: boolean;
  /** Windows only. */
  pause_on_lock: boolean;
}

/** Full state snapshot returned by all backend commands. */
export interface StateSnapshot {
  status: ReminderStatus;
  config: ReminderConfig;
  reminder_count: number;
  /** Seconds until the next reminder fires. null when not running. */
  seconds_until_next: number | null;
}
