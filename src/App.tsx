import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ---------------------------------------------------------------------------
// Type definitions that mirror the Rust backend structs
// ---------------------------------------------------------------------------

type ThemePreference = "System" | "AlwaysLight" | "AlwaysDark";
type EffectiveTheme = "light" | "dark";

/** Configuration settings for the reminder timer. */
interface ReminderConfig {
  /** How often to fire a reminder, in minutes. */
  interval_minutes: number;
  /** Maximum number of reminders before auto-stopping. null = infinite. */
  max_count: number | null;
  /** Visual theme preference for the app. */
  theme_preference: ThemePreference;
  /** How long to delay the reminder when snoozed, in minutes. */
  snooze_minutes: number;
  /** When true, reminders start automatically when the app launches. */
  auto_start: boolean;
  /** When true, the timer waits for the user to acknowledge before starting the next interval. */
  require_acknowledgment: boolean;
  /** When true, an alert sound is played when a reminder fires. */
  play_sound: boolean;
  /** When true, the alert sound repeats every 10 seconds until the reminder is resolved. */
  repeat_sound_until_action: boolean;
  /** When true, the window is brought to the front when a reminder fires. */
  focus_window: boolean;
  /** When true, the taskbar / dock icon flashes when a reminder fires. */
  flash_taskbar: boolean;
  /** When true, the window is minimized after acknowledging a pending reminder. */
  minimize_on_acknowledge: boolean;
  /** When true, the window is kept always on top while waiting for acknowledgment.
   *  Only has effect when focus_window is also true. */
  always_on_top_while_waiting: boolean;
}

/** Possible states of the reminder timer. */
type ReminderStatus = "Stopped" | "Running" | "Paused" | "WaitingAck";

/** Full state snapshot returned by backend commands. */
interface StateSnapshot {
  status: ReminderStatus;
  config: ReminderConfig;
  reminder_count: number;
  /** Seconds until the next reminder fires. null when not running. */
  seconds_until_next: number | null;
}

// ---------------------------------------------------------------------------
// Alert sound
// ---------------------------------------------------------------------------

/**
 * Play a short water-drop-style alert tone using the Web Audio API.
 * Errors are silently ignored (e.g. when audio context is not available).
 */
function playAlertSound(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "sine";
    // Rising tone: 440 Hz → 880 Hz over 120 ms, then fade out
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);

    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.65);
    osc.onended = () => void ctx.close();
  } catch (e) {
    // Web Audio not available – ignore silently.
    console.error("[water-reminder] Failed to play alert sound:", e);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a duration (in seconds) as mm:ss. Returns "--:--" for null. */
function formatCountdown(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Default config values used when the app first loads (before backend responds). */
const DEFAULT_CONFIG: ReminderConfig = {
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
};

/** Default state when the app first loads. */
const DEFAULT_STATE: StateSnapshot = {
  status: "Stopped",
  config: DEFAULT_CONFIG,
  reminder_count: 0,
  seconds_until_next: null,
};

// How long to wait (ms) after the last form change before auto-saving.
const AUTOSAVE_DEBOUNCE_MS = 500;
const ALERT_REPEAT_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

function App() {
  // The last full state snapshot received from the backend.
  const [remState, setRemState] = useState<StateSnapshot>(DEFAULT_STATE);

  // Settings that the user is currently editing in the form.
  const [formInterval, setFormInterval] = useState(DEFAULT_CONFIG.interval_minutes);
  const [formSnooze, setFormSnooze] = useState(DEFAULT_CONFIG.snooze_minutes);
  const [isInfinite, setIsInfinite] = useState(true);
  const [formMaxCount, setFormMaxCount] = useState(10);
  const [formThemePreference, setFormThemePreference] = useState<ThemePreference>(
    DEFAULT_CONFIG.theme_preference,
  );
  const [formAutoStart, setFormAutoStart] = useState(DEFAULT_CONFIG.auto_start);
  const [formRequireAck, setFormRequireAck] = useState(DEFAULT_CONFIG.require_acknowledgment);
  const [formPlaySound, setFormPlaySound] = useState(DEFAULT_CONFIG.play_sound);
  const [formRepeatSoundUntilAction, setFormRepeatSoundUntilAction] = useState(
    DEFAULT_CONFIG.repeat_sound_until_action,
  );
  const [formFocusWindow, setFormFocusWindow] = useState(DEFAULT_CONFIG.focus_window);
  const [formFlashTaskbar, setFormFlashTaskbar] = useState(DEFAULT_CONFIG.flash_taskbar);
  const [formMinimizeOnAcknowledge, setFormMinimizeOnAcknowledge] = useState(
    DEFAULT_CONFIG.minimize_on_acknowledge,
  );
  const [formAlwaysOnTopWhileWaiting, setFormAlwaysOnTopWhileWaiting] = useState(
    DEFAULT_CONFIG.always_on_top_while_waiting,
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark);

  // Whether to show the snooze button prominently (set true after a reminder fires).
  const [showSnoozeBanner, setShowSnoozeBanner] = useState(false);

  // Whether the UI is currently flashing to draw attention to a reminder.
  const [isFlashing, setIsFlashing] = useState(false);

  // Whether the settings panel is expanded.
  const [settingsOpen, setSettingsOpen] = useState(true);

  // Latest error message to show to the user.
  const [error, setError] = useState<string | null>(null);

  // Ref to store the snooze-banner auto-hide timer so we can cancel it.
  const snoozeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref to store the auto-clear timer for the UI flash effect.
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref to store the debounce timer for auto-saving settings.
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref to store the repeating sound timer while waiting for acknowledgment.
  const repeatSoundTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tracks the latest reminder status for the close-request handler.
  const reminderStatusRef = useRef<ReminderStatus>(DEFAULT_STATE.status);
  const previousReminderStatusRef = useRef<ReminderStatus>(DEFAULT_STATE.status);

  // Prevents multiple overlapping exit confirmation prompts.
  const closePromptOpenRef = useRef(false);

  // Avoids issuing multiple destroy() calls if the user clicks close repeatedly.
  const closeInProgressRef = useRef(false);

  // Flag that tells the auto-save effect to skip the very first render,
  // since the initial values come from the backend (not from user input).
  const isInitialLoadRef = useRef(true);

  // Ref that always mirrors the current formPlaySound value so the event
  // listener (which only mounts once) can read the latest setting without
  // becoming stale.
  const playSoundRef = useRef(DEFAULT_CONFIG.play_sound);
  useEffect(() => {
    playSoundRef.current = formPlaySound;
  }, [formPlaySound]);

  useEffect(() => {
    reminderStatusRef.current = remState.status;
  }, [remState.status]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    setSystemPrefersDark(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  const effectiveTheme: EffectiveTheme =
    formThemePreference === "AlwaysDark"
      ? "dark"
      : formThemePreference === "AlwaysLight"
        ? "light"
        : systemPrefersDark
          ? "dark"
          : "light";

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", effectiveTheme);
    document.documentElement.style.colorScheme = effectiveTheme;
  }, [effectiveTheme]);

  // ---------------------------------------------------------------------------
  // Load initial state from the backend on first render.
  // The backend's setup hook restores the last-saved config, so get_status
  // returns persisted values from the very first call.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    invoke<StateSnapshot>("get_status")
      .then((snapshot) => {
        setRemState(snapshot);
        // Populate the form with whatever the backend currently has.
        setFormInterval(snapshot.config.interval_minutes);
        setFormSnooze(snapshot.config.snooze_minutes);
        setIsInfinite(snapshot.config.max_count === null);
        setFormMaxCount(snapshot.config.max_count ?? 10);
        setFormThemePreference(snapshot.config.theme_preference);
        setFormAutoStart(snapshot.config.auto_start);
        setFormRequireAck(snapshot.config.require_acknowledgment);
        setFormPlaySound(snapshot.config.play_sound);
        setFormRepeatSoundUntilAction(snapshot.config.repeat_sound_until_action);
        setFormFocusWindow(snapshot.config.focus_window);
        setFormFlashTaskbar(snapshot.config.flash_taskbar);
        setFormMinimizeOnAcknowledge(snapshot.config.minimize_on_acknowledge);
        setFormAlwaysOnTopWhileWaiting(snapshot.config.always_on_top_while_waiting);
        // Mark the initial load as done so subsequent changes auto-save.
        isInitialLoadRef.current = false;
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  // ---------------------------------------------------------------------------
  // Auto-save settings whenever the user changes a form field.
  //
  // A 500 ms debounce prevents a save on every keystroke when typing a number.
  // The save is skipped during the initial load (when values come from the
  // backend rather than from user interaction).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Skip the very first render – values are being populated from the backend.
    if (isInitialLoadRef.current) return;

    // Clear any pending debounce timer.
    if (autosaveTimerRef.current !== null) clearTimeout(autosaveTimerRef.current);

    autosaveTimerRef.current = setTimeout(() => {
      const config: ReminderConfig = {
        interval_minutes: formInterval,
        max_count: isInfinite ? null : formMaxCount,
        theme_preference: formThemePreference,
        snooze_minutes: formSnooze,
        auto_start: formAutoStart,
        require_acknowledgment: formRequireAck,
        play_sound: formPlaySound,
        repeat_sound_until_action: formRepeatSoundUntilAction,
        focus_window: formFocusWindow,
        flash_taskbar: formFlashTaskbar,
        minimize_on_acknowledge: formMinimizeOnAcknowledge,
        always_on_top_while_waiting: formAlwaysOnTopWhileWaiting,
      };

      // save_config validates, persists to disk, and updates the in-memory config.
      invoke<StateSnapshot>("save_config", { config })
        .then(setRemState)
        .catch((e: unknown) => setError(String(e)));
    }, AUTOSAVE_DEBOUNCE_MS);

    // Cancel on unmount.
    return () => {
      if (autosaveTimerRef.current !== null) clearTimeout(autosaveTimerRef.current);
    };
    // Re-run whenever any form field changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    formInterval,
    formSnooze,
    isInfinite,
    formMaxCount,
    formThemePreference,
    formAutoStart,
    formRequireAck,
    formPlaySound,
    formRepeatSoundUntilAction,
    formFocusWindow,
    formFlashTaskbar,
    formMinimizeOnAcknowledge,
    formAlwaysOnTopWhileWaiting,
  ]);

  useEffect(() => {
    if (repeatSoundTimerRef.current !== null) {
      clearInterval(repeatSoundTimerRef.current);
      repeatSoundTimerRef.current = null;
    }

    if (
      remState.status !== "WaitingAck" ||
      !formPlaySound ||
      !formRepeatSoundUntilAction
    ) {
      return;
    }

    repeatSoundTimerRef.current = setInterval(() => {
      playAlertSound();
    }, ALERT_REPEAT_INTERVAL_MS);

    return () => {
      if (repeatSoundTimerRef.current !== null) {
        clearInterval(repeatSoundTimerRef.current);
        repeatSoundTimerRef.current = null;
      }
    };
  }, [
    formPlaySound,
    formRepeatSoundUntilAction,
    remState.status,
  ]);

  /** Stop the UI flash animation and cancel the auto-clear safety timer. */
  const clearFlashEffect = useCallback(() => {
    setIsFlashing(false);
    if (flashTimerRef.current !== null) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Manage always-on-top state in the frontend.
  //
  // We do this in TypeScript rather than from the Rust timer thread because
  // the timer thread calls Win32 SetWindowPos with SWP_ASYNCWINDOWPOS (required
  // for cross-thread calls), and bring_window_to_front posts TOPMOST then
  // NOTOPMOST to the message queue.  Any Win32 call we make from the timer
  // thread races with those queued messages.  By the time the TypeScript effect
  // runs, all queued Win32 messages have long been processed, so our IPC call
  // to setAlwaysOnTop wins cleanly.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (remState.status !== "WaitingAck" || !formFocusWindow || !formAlwaysOnTopWhileWaiting) {
      return;
    }

    const appWindow = getCurrentWindow();
    void appWindow.setAlwaysOnTop(true);

    return () => {
      void appWindow.setAlwaysOnTop(false);
    };
  }, [remState.status, formFocusWindow, formAlwaysOnTopWhileWaiting]);

  useEffect(() => {
    const previousStatus = previousReminderStatusRef.current;

    if (previousStatus === "WaitingAck" && remState.status !== "WaitingAck") {
      setShowSnoozeBanner(false);
      clearFlashEffect();
    }

    if (previousStatus === "Stopped" && remState.status === "Running") {
      setSettingsOpen(false);
    }

    previousReminderStatusRef.current = remState.status;
  }, [clearFlashEffect, remState.status]);

  // ---------------------------------------------------------------------------
  // Subscribe to backend events
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    const appWindow = getCurrentWindow();
    let disposed = false;

    const registerListeners = async () => {
      try {
        const reminderFiredUnlisten = await listen<number>("reminder-fired", (_e) => {
          if (playSoundRef.current) playAlertSound();

          invoke<StateSnapshot>("get_status")
            .then(setRemState)
            .catch((e: unknown) => setError(String(e)));

          setShowSnoozeBanner(true);
          if (snoozeTimerRef.current !== null) clearTimeout(snoozeTimerRef.current);
          snoozeTimerRef.current = setTimeout(() => setShowSnoozeBanner(false), 30_000);

          // Start the UI flash effect; auto-clear after 30 s as a safety net.
          setIsFlashing(true);
          if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
          flashTimerRef.current = setTimeout(() => setIsFlashing(false), 30_000);
        });

        if (disposed) {
          reminderFiredUnlisten();
          return;
        }
        unlisteners.push(reminderFiredUnlisten);

        const reminderCompletedUnlisten = await listen<number>("reminder-completed", (_e) => {
          invoke<StateSnapshot>("get_status")
            .then(setRemState)
            .catch((e: unknown) => setError(String(e)));
          setShowSnoozeBanner(false);
          clearFlashEffect();
        });

        if (disposed) {
          reminderCompletedUnlisten();
          return;
        }
        unlisteners.push(reminderCompletedUnlisten);

        const closeUnlisten = await appWindow.onCloseRequested(async (event) => {
          event.preventDefault();

          if (closeInProgressRef.current || closePromptOpenRef.current) return;

          const status = reminderStatusRef.current;
          const hasActiveReminderSession =
            status === "Running" || status === "Paused" || status === "WaitingAck";

          if (!hasActiveReminderSession) {
            try {
              closeInProgressRef.current = true;
              await appWindow.destroy();
            } catch (e) {
              closeInProgressRef.current = false;
              setError(`Failed to close window: ${String(e)}`);
            }
            return;
          }

          let confirmed = false;
          closePromptOpenRef.current = true;
          try {
            confirmed = await confirm(
              "A reminder session is still active. Are you sure you want to close Water Reminder?",
              {
                title: "Close Water Reminder?",
                kind: "warning",
              },
            );
          } catch (e) {
            setError(`Failed to show close confirmation: ${String(e)}`);
            return;
          } finally {
            closePromptOpenRef.current = false;
          }

          if (!confirmed) return;

          try {
            closeInProgressRef.current = true;
            await appWindow.destroy();
          } catch (e) {
            closeInProgressRef.current = false;
            setError(`Failed to close window: ${String(e)}`);
          }
        });

        if (disposed) {
          closeUnlisten();
          return;
        }
        unlisteners.push(closeUnlisten);
      } catch (e) {
        console.error("[water-reminder] Failed to register app window listeners:", e);
      }
    };

    void registerListeners();

    // Clean up listeners when the component unmounts.
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
      if (snoozeTimerRef.current !== null) clearTimeout(snoozeTimerRef.current);
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
      if (repeatSoundTimerRef.current !== null) clearInterval(repeatSoundTimerRef.current);
    };
  }, [clearFlashEffect]);

  // ---------------------------------------------------------------------------
  // Poll the backend every second while the timer is Running to keep the
  // countdown display in sync.  No polling needed for WaitingAck since there
  // is no countdown – all state transitions there are user-initiated.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (remState.status !== "Running") return;

    const id = setInterval(() => {
      invoke<StateSnapshot>("get_status")
        .then(setRemState)
        .catch((e: unknown) => setError(String(e)));
    }, 1_000);

    return () => clearInterval(id);
  }, [remState.status]);

  // ---------------------------------------------------------------------------
  // Command handlers
  // ---------------------------------------------------------------------------

  /** Build the config object from current form values. */
  const buildConfig = useCallback((): ReminderConfig => ({
    interval_minutes: formInterval,
    max_count: isInfinite ? null : formMaxCount,
    theme_preference: formThemePreference,
    snooze_minutes: formSnooze,
    auto_start: formAutoStart,
    require_acknowledgment: formRequireAck,
    play_sound: formPlaySound,
    repeat_sound_until_action: formRepeatSoundUntilAction,
    focus_window: formFocusWindow,
    flash_taskbar: formFlashTaskbar,
    minimize_on_acknowledge: formMinimizeOnAcknowledge,
    always_on_top_while_waiting: formAlwaysOnTopWhileWaiting,
  }), [
    formInterval,
    isInfinite,
    formMaxCount,
    formThemePreference,
    formSnooze,
    formAutoStart,
    formRequireAck,
    formPlaySound,
    formRepeatSoundUntilAction,
    formFocusWindow,
    formFlashTaskbar,
    formMinimizeOnAcknowledge,
    formAlwaysOnTopWhileWaiting,
  ]);

  useEffect(() => {
    if (
      isInitialLoadRef.current ||
      remState.status !== "WaitingAck" ||
      formRequireAck ||
      !remState.config.require_acknowledgment
    ) {
      return;
    }

    if (autosaveTimerRef.current !== null) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    invoke<StateSnapshot>("save_config", { config: buildConfig() })
      .then(setRemState)
      .catch((e: unknown) => setError(String(e)));
  }, [buildConfig, formRequireAck, remState.config.require_acknowledgment, remState.status]);

  /** Start the reminder timer with the current settings. */
  const handleStart = useCallback(async () => {
    try {
      setError(null);
      const snapshot = await invoke<StateSnapshot>("start_reminders", {
        config: buildConfig(),
      });
      setRemState(snapshot);
    } catch (e) {
      setError(String(e));
    }
  }, [buildConfig]);

  /** Stop the reminder timer completely. Reminder count resets to zero. */
  const handleStop = useCallback(async () => {
    try {
      setError(null);
      const snapshot = await invoke<StateSnapshot>("stop_reminders");
      setRemState(snapshot);
      setShowSnoozeBanner(false);
      clearFlashEffect();
    } catch (e) {
      setError(String(e));
    }
  }, [clearFlashEffect]);

  /** Toggle between Paused and Running. Pause preserves the current count. */
  const handlePauseResume = useCallback(async () => {
    try {
      setError(null);
      const cmd =
        remState.status === "Running" ? "pause_reminders" : "resume_reminders";
      const snapshot = await invoke<StateSnapshot>(cmd);
      setRemState(snapshot);
    } catch (e) {
      setError(String(e));
    }
  }, [remState.status]);

  /** Reset the counter and stop the timer. */
  const handleReset = useCallback(async () => {
    try {
      setError(null);
      const snapshot = await invoke<StateSnapshot>("reset_reminders");
      setRemState(snapshot);
      setShowSnoozeBanner(false);
      clearFlashEffect();
    } catch (e) {
      setError(String(e));
    }
  }, [clearFlashEffect]);

  /** Snooze the current reminder – delays the next fire by snooze_minutes. */
  const handleSnooze = useCallback(async () => {
    try {
      setError(null);
      const snapshot = await invoke<StateSnapshot>("snooze_reminder");
      setRemState(snapshot);
      setShowSnoozeBanner(false);
      clearFlashEffect();
    } catch (e) {
      setError(String(e));
    }
  }, [clearFlashEffect]);

  /** Acknowledge the reminder and start the next full interval. */
  const handleAcknowledge = useCallback(async () => {
    try {
      setError(null);
      const snapshot = await invoke<StateSnapshot>("acknowledge_reminder");
      setRemState(snapshot);
      setShowSnoozeBanner(false);
      clearFlashEffect();
    } catch (e) {
      setError(String(e));
    }
  }, [clearFlashEffect]);

  /** Restart the active countdown from the full configured interval. */
  const handleDrinkWater = useCallback(async () => {
    try {
      setError(null);
      const snapshot = await invoke<StateSnapshot>("reset_active_countdown");
      setRemState(snapshot);
      setShowSnoozeBanner(false);
      clearFlashEffect();
    } catch (e) {
      setError(String(e));
    }
  }, [clearFlashEffect]);

  // ---------------------------------------------------------------------------
  // Derived state flags used to drive the UI
  // ---------------------------------------------------------------------------
  const isRunning = remState.status === "Running";
  const isPaused = remState.status === "Paused";
  const isStopped = remState.status === "Stopped";
  const isWaitingAck = remState.status === "WaitingAck";
  const canEditTimingSettings = isStopped;

  // Show the snooze button when the timer is active or a reminder just fired.
  const showSnooze = !isStopped && (showSnoozeBanner || isRunning || isPaused || isWaitingAck);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className={`app${isFlashing ? " app--flashing" : ""}`}>
      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-icon" aria-hidden="true">💧</div>
        <h1>Water Reminder</h1>
        <p className="tagline">Stay hydrated, stay healthy!</p>
      </header>

      {/* ── Status card ── */}
      <section className="card status-card" aria-label="Current status">
        {/* Running / Paused / WaitingAck / Stopped badge */}
        <div
          className={`status-badge status-${remState.status.toLowerCase()}`}
          role="status"
          aria-live="polite"
        >
          {isRunning && "🟢 Running"}
          {isPaused && "⏸ Paused"}
          {isStopped && "⏹ Stopped"}
          {isWaitingAck && "⏰ Reminder!"}
        </div>

        {/* Countdown – only meaningful while Running or Paused */}
        {(isRunning || isPaused) && (
          <div className="countdown" aria-label="Time until next reminder">
            <span className="countdown-label">Next reminder in</span>
            <span className="countdown-time">
              {isPaused ? "—paused—" : formatCountdown(remState.seconds_until_next)}
            </span>
          </div>
        )}

        {/* Reminder counter */}
        <div className="reminder-counter" aria-label="Reminders sent">
          <span className="counter-number">{remState.reminder_count}</span>
          <span className="counter-label">
            {" "}reminder{remState.reminder_count !== 1 ? "s" : ""} sent
            {remState.config.max_count !== null &&
              ` / ${remState.config.max_count} max`}
          </span>
        </div>
      </section>

      {/* ── Acknowledgment card – shown when waiting for user to confirm ── */}
      {isWaitingAck && (
        <section className="card ack-card" aria-live="assertive" aria-label="Reminder acknowledgment">
          <div className="ack-icon" aria-hidden="true">💧</div>
          <h2 className="ack-title">Time to Drink Water!</h2>
          <p className="ack-subtitle">
            Take a moment to hydrate before your next reminder starts.
          </p>
          <div className="ack-buttons">
            <button
              className="btn btn-acknowledge"
              onClick={handleAcknowledge}
              aria-label="Acknowledge – I drank water, start the next reminder interval"
            >
              ✓ I Drank Water!
            </button>
            <button
              className="btn btn-snooze"
              onClick={handleSnooze}
              aria-label={`Snooze reminder for ${remState.config.snooze_minutes} minutes`}
            >
              💤 Snooze ({remState.config.snooze_minutes} min)
            </button>
          </div>
        </section>
      )}

      {/* ── Controls card ── */}
      <section className="card controls-card" aria-label="Timer controls">
        {/* Error banner */}
        {error && (
          <div className="error-banner" role="alert" aria-live="assertive">
            <span>⚠️ {error}</span>
            <button
              className="error-dismiss"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        )}

        {/* Primary control buttons */}
        <div className="button-grid">
          {/* Start – only active when stopped */}
          <button
            className="btn btn-start"
            onClick={handleStart}
            disabled={isRunning || isPaused || isWaitingAck}
            aria-label="Start reminders"
          >
            ▶ Start
          </button>

          {/* Pause / Resume – toggles between the two states */}
          <button
            className="btn btn-pause"
            onClick={handlePauseResume}
            disabled={isStopped || isWaitingAck}
            aria-label={isPaused ? "Resume reminders" : "Pause reminders"}
          >
            {isPaused ? "▶ Resume" : "⏸ Pause"}
          </button>

          {/* Stop – disabled when already stopped; also resets the counter */}
          <button
            className="btn btn-stop"
            onClick={handleStop}
            disabled={isStopped}
            aria-label="Stop reminders"
          >
            ⏹ Stop
          </button>

          {/* Reset – always available to clear the counter */}
          <button
            className="btn btn-reset"
            onClick={handleReset}
            aria-label="Reset reminders"
          >
            ↺ Reset
          </button>
        </div>

        {/* Running-state reminder actions live below the primary controls. */}
        {!isWaitingAck && (
          <div className="secondary-actions">
            <button
              className="btn btn-acknowledge"
              onClick={handleDrinkWater}
              disabled={!isRunning}
              aria-label="I drank water and want to restart the reminder interval"
            >
              ✓ I Drank Water!
            </button>

            {showSnooze && (
              <button
                className="btn btn-snooze"
                onClick={handleSnooze}
                aria-label={`Snooze reminder for ${remState.config.snooze_minutes} minutes`}
              >
                💤 Snooze ({remState.config.snooze_minutes} min)
              </button>
            )}
          </div>
        )}
      </section>

      {/* ── Settings card ── */}
      <section className="card settings-card" aria-label="Reminder settings">
        <div className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button
            type="button"
            className="settings-toggle"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-expanded={settingsOpen}
            aria-controls="settings-body"
            aria-label={settingsOpen ? "Collapse settings" : "Expand settings"}
          >
            <span>{settingsOpen ? "Collapse" : "Expand"}</span>
            <span className="settings-chevron" aria-hidden="true">
              {settingsOpen ? "▲" : "▼"}
            </span>
          </button>
        </div>

        <div
          id="settings-body"
          className={`settings-body${settingsOpen ? "" : " settings-body--collapsed"}`}
          aria-labelledby="settings-title"
          aria-hidden={!settingsOpen}
        >
          <p className="settings-hint">
            {isStopped
              ? "All settings are saved automatically as you type."
              : "Theme, startup, and notification settings save automatically during active reminders. Stop the timer to change interval, max reminders, or snooze duration."}
          </p>

          {/* Interval */}
          <div className="form-group">
            <label htmlFor="interval-input">
              Reminder Interval
              <span className="unit-label">(minutes)</span>
            </label>
            <input
              id="interval-input"
              type="number"
              min={1}
              max={1440}
              value={formInterval}
              disabled={!canEditTimingSettings}
              onChange={(e) =>
                setFormInterval(Math.max(1, parseInt(e.target.value) || 1))
              }
              aria-describedby="interval-desc"
            />
            <span id="interval-desc" className="field-hint">
              How frequently you want to be reminded (1–1440 min).
            </span>
          </div>

          {/* Max reminders */}
          <div className="form-group">
            <fieldset disabled={!canEditTimingSettings}>
              <legend>
                Maximum Reminders
              </legend>
              <div className="radio-group">
                {/* Infinite option */}
                <label className="radio-label">
                  <input
                    type="radio"
                    name="max-count"
                    checked={isInfinite}
                    onChange={() => setIsInfinite(true)}
                  />
                  Infinite (never stop automatically)
                </label>

                {/* Limited option */}
                <label className="radio-label">
                  <input
                    type="radio"
                    name="max-count"
                    checked={!isInfinite}
                    onChange={() => setIsInfinite(false)}
                  />
                  Limited:&nbsp;
                  <input
                    type="number"
                    min={1}
                    max={9999}
                    value={formMaxCount}
                    disabled={isInfinite || !canEditTimingSettings}
                    className="inline-number"
                    aria-label="Maximum reminder count"
                    onChange={(e) =>
                      setFormMaxCount(Math.max(1, parseInt(e.target.value) || 1))
                    }
                  />
                  &nbsp;reminders
                </label>
              </div>
            </fieldset>
          </div>

          {/* Snooze duration */}
          <div className="form-group">
            <label htmlFor="snooze-input">
              Snooze Duration
              <span className="unit-label">(minutes)</span>
            </label>
            <input
              id="snooze-input"
              type="number"
              min={1}
              max={60}
              value={formSnooze}
              disabled={!canEditTimingSettings}
              onChange={(e) =>
                setFormSnooze(Math.max(1, parseInt(e.target.value) || 1))
              }
              aria-describedby="snooze-desc"
            />
            <span id="snooze-desc" className="field-hint">
              How long to delay the reminder when you snooze it (1–60 min).
            </span>
          </div>

          <div className="form-group">
            <fieldset>
              <legend>Theme</legend>
              <div className="radio-group">
                <label className="radio-label">
                  <input
                    type="radio"
                    name="theme-preference"
                    checked={formThemePreference === "System"}
                    onChange={() => setFormThemePreference("System")}
                  />
                  Follow system setting
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="theme-preference"
                    checked={formThemePreference === "AlwaysLight"}
                    onChange={() => setFormThemePreference("AlwaysLight")}
                  />
                  Always light
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="theme-preference"
                    checked={formThemePreference === "AlwaysDark"}
                    onChange={() => setFormThemePreference("AlwaysDark")}
                  />
                  Always dark
                </label>
              </div>
            </fieldset>
            <span className="field-hint">
              The reminder flash still desaturates the UI; in dark mode it brightens instead of darkening.
            </span>
          </div>

          <div className="form-group">
            <fieldset>
              <legend>Startup</legend>
              <div className="toggle-group">
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={formAutoStart}
                    onChange={(e) => setFormAutoStart(e.target.checked)}
                  />
                  <span>Automatically start reminders when the app launches</span>
                </label>
              </div>
            </fieldset>
            <span className="field-hint">
              When enabled, launch starts a fresh reminder session using your saved settings.
            </span>
          </div>

          {/* Notification behaviour toggles */}
          <div className="form-group">
            <fieldset>
              <legend>Notification Behavior</legend>
              <div className="toggle-group">
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={formRequireAck}
                    onChange={(e) => setFormRequireAck(e.target.checked)}
                  />
                  <span>Require acknowledgment before next reminder</span>
                </label>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={formPlaySound}
                    onChange={(e) => setFormPlaySound(e.target.checked)}
                  />
                  <span>Play alert sound</span>
                </label>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={formRepeatSoundUntilAction}
                    onChange={(e) => setFormRepeatSoundUntilAction(e.target.checked)}
                  />
                  <span>Repeat sound every 10 seconds until acknowledged or snoozed</span>
                </label>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={formFocusWindow}
                    onChange={(e) => setFormFocusWindow(e.target.checked)}
                  />
                  <span>Bring window to front (without focus on Windows)</span>
                </label>
                <label className={`toggle-label${!formFocusWindow ? " toggle-label--disabled" : ""}`}>
                  <input
                    type="checkbox"
                    checked={formAlwaysOnTopWhileWaiting}
                    disabled={!formFocusWindow}
                    onChange={(e) => setFormAlwaysOnTopWhileWaiting(e.target.checked)}
                  />
                  <span>Keep window always on top while waiting for acknowledgment</span>
                </label>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={formFlashTaskbar}
                    onChange={(e) => setFormFlashTaskbar(e.target.checked)}
                  />
                  <span>Flash taskbar / dock icon</span>
                </label>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={formMinimizeOnAcknowledge}
                    onChange={(e) => setFormMinimizeOnAcknowledge(e.target.checked)}
                  />
                  <span>Minimize window to taskbar when acknowledging a reminder</span>
                </label>
              </div>
            </fieldset>
            <span className="field-hint">
              These settings stay editable in all active reminder states and apply immediately.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

export default App;
