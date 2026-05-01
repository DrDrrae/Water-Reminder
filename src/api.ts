// api.ts — typed wrappers around all Tauri IPC commands.
//
// Each wrapper returns the same `Promise<StateSnapshot>` that the backend
// always resolves to on success, and rejects with an error string on failure.
// This removes the raw string command names from component and hook code.

import { invoke } from "@tauri-apps/api/core";
import type { ReminderConfig, StateSnapshot } from "./types";

export const api = {
  getStatus: (): Promise<StateSnapshot> =>
    invoke<StateSnapshot>("get_status"),

  saveConfig: (config: ReminderConfig): Promise<StateSnapshot> =>
    invoke<StateSnapshot>("save_config", { config }),

  startReminders: (config: ReminderConfig): Promise<StateSnapshot> =>
    invoke<StateSnapshot>("start_reminders", { config }),

  stopReminders: (): Promise<StateSnapshot> =>
    invoke<StateSnapshot>("stop_reminders"),

  pauseReminders: (): Promise<StateSnapshot> =>
    invoke<StateSnapshot>("pause_reminders"),

  resumeReminders: (): Promise<StateSnapshot> =>
    invoke<StateSnapshot>("resume_reminders"),

  resetReminders: (): Promise<StateSnapshot> =>
    invoke<StateSnapshot>("reset_reminders"),

  snoozeReminder: (): Promise<StateSnapshot> =>
    invoke<StateSnapshot>("snooze_reminder"),

  acknowledgeReminder: (): Promise<StateSnapshot> =>
    invoke<StateSnapshot>("acknowledge_reminder"),

  resetActiveCountdown: (): Promise<StateSnapshot> =>
    invoke<StateSnapshot>("reset_active_countdown"),
};
