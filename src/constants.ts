// constants.ts — application-wide defaults and timing constants.

import type { ReminderConfig, StateSnapshot } from "./types";

export const DEFAULT_CONFIG: ReminderConfig = {
  interval_minutes: 60,
  max_count: null,
  theme_preference: "System",
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
};

export const DEFAULT_STATE: StateSnapshot = {
  status: "Stopped",
  config: DEFAULT_CONFIG,
  reminder_count: 0,
  seconds_until_next: null,
};

/** How long to wait (ms) after the last form change before auto-saving. */
export const AUTOSAVE_DEBOUNCE_MS = 500;

/** How long to wait (ms) between repeat alert sounds while in WaitingAck. */
export const ALERT_REPEAT_INTERVAL_MS = 10_000;
