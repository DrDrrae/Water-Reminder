import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Type definitions that mirror the Rust backend structs
// ---------------------------------------------------------------------------

/** Configuration settings for the reminder timer. */
interface ReminderConfig {
  /** How often to fire a reminder, in minutes. */
  interval_minutes: number;
  /** Maximum number of reminders before auto-stopping. null = infinite. */
  max_count: number | null;
  /** How long to delay the reminder when snoozed, in minutes. */
  snooze_minutes: number;
  /** When true, the timer waits for the user to acknowledge before starting the next interval. */
  require_acknowledgment: boolean;
  /** When true, an alert sound is played when a reminder fires. */
  play_sound: boolean;
  /** When true, the window is brought to the front when a reminder fires. */
  focus_window: boolean;
  /** When true, the taskbar / dock icon flashes when a reminder fires. */
  flash_taskbar: boolean;
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

/** Default config values used when the app first loads (before backend responds). */
const DEFAULT_CONFIG: ReminderConfig = {
  interval_minutes: 60,
  max_count: null,
  snooze_minutes: 5,
  require_acknowledgment: true,
  play_sound: true,
  focus_window: true,
  flash_taskbar: true,
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
  const [formRequireAck, setFormRequireAck] = useState(DEFAULT_CONFIG.require_acknowledgment);
  const [formPlaySound, setFormPlaySound] = useState(DEFAULT_CONFIG.play_sound);
  const [formFocusWindow, setFormFocusWindow] = useState(DEFAULT_CONFIG.focus_window);
  const [formFlashTaskbar, setFormFlashTaskbar] = useState(DEFAULT_CONFIG.flash_taskbar);

  // Whether to show the snooze button prominently (set true after a reminder fires).
  const [showSnoozeBanner, setShowSnoozeBanner] = useState(false);

  // Whether the settings panel is expanded.
  const [settingsOpen, setSettingsOpen] = useState(true);

  // Latest error message to show to the user.
  const [error, setError] = useState<string | null>(null);

  // Ref to store the snooze-banner auto-hide timer so we can cancel it.
  const snoozeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref to store the debounce timer for auto-saving settings.
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        setFormRequireAck(snapshot.config.require_acknowledgment);
        setFormPlaySound(snapshot.config.play_sound);
        setFormFocusWindow(snapshot.config.focus_window);
        setFormFlashTaskbar(snapshot.config.flash_taskbar);
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
        snooze_minutes: formSnooze,
        require_acknowledgment: formRequireAck,
        play_sound: formPlaySound,
        focus_window: formFocusWindow,
        flash_taskbar: formFlashTaskbar,
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
  }, [formInterval, formSnooze, isInfinite, formMaxCount, formRequireAck, formPlaySound, formFocusWindow, formFlashTaskbar]);

  // ---------------------------------------------------------------------------
  // Subscribe to backend events
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    // Fired each time a reminder notification is sent.
    listen<number>("reminder-fired", (_e) => {
      // Play the alert sound if the setting is enabled.
      if (playSoundRef.current) playAlertSound();

      // Refresh full state so the count and status are accurate.
      invoke<StateSnapshot>("get_status")
        .then(setRemState)
        .catch((e: unknown) => setError(String(e)));

      // Show the snooze banner and auto-hide it after 30 seconds.
      setShowSnoozeBanner(true);
      if (snoozeTimerRef.current !== null) clearTimeout(snoozeTimerRef.current);
      snoozeTimerRef.current = setTimeout(() => setShowSnoozeBanner(false), 30_000);
    })
      .then((fn) => unlisteners.push(fn))
      .catch(console.error);

    // Fired when the reminder has reached its maximum count and auto-stopped.
    listen<number>("reminder-completed", (_e) => {
      invoke<StateSnapshot>("get_status")
        .then(setRemState)
        .catch((e: unknown) => setError(String(e)));
      setShowSnoozeBanner(false);
    })
      .then((fn) => unlisteners.push(fn))
      .catch(console.error);

    // Clean up listeners when the component unmounts.
    return () => {
      unlisteners.forEach((fn) => fn());
      if (snoozeTimerRef.current !== null) clearTimeout(snoozeTimerRef.current);
    };
  }, []);

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

  // Auto-collapse settings when reminders are running to free vertical space.
  useEffect(() => {
    if (remState.status === "Running") setSettingsOpen(false);
  }, [remState.status]);

  // ---------------------------------------------------------------------------
  // Command handlers
  // ---------------------------------------------------------------------------

  /** Build the config object from current form values. */
  const buildConfig = useCallback((): ReminderConfig => ({
    interval_minutes: formInterval,
    max_count: isInfinite ? null : formMaxCount,
    snooze_minutes: formSnooze,
    require_acknowledgment: formRequireAck,
    play_sound: formPlaySound,
    focus_window: formFocusWindow,
    flash_taskbar: formFlashTaskbar,
  }), [formInterval, isInfinite, formMaxCount, formSnooze, formRequireAck, formPlaySound, formFocusWindow, formFlashTaskbar]);

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
    } catch (e) {
      setError(String(e));
    }
  }, []);

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
    } catch (e) {
      setError(String(e));
    }
  }, []);

  /** Snooze the current reminder – delays the next fire by snooze_minutes. */
  const handleSnooze = useCallback(async () => {
    try {
      setError(null);
      const snapshot = await invoke<StateSnapshot>("snooze_reminder");
      setRemState(snapshot);
      setShowSnoozeBanner(false);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  /** Acknowledge the reminder and start the next full interval. */
  const handleAcknowledge = useCallback(async () => {
    try {
      setError(null);
      const snapshot = await invoke<StateSnapshot>("acknowledge_reminder");
      setRemState(snapshot);
      setShowSnoozeBanner(false);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Derived state flags used to drive the UI
  // ---------------------------------------------------------------------------
  const isRunning = remState.status === "Running";
  const isPaused = remState.status === "Paused";
  const isStopped = remState.status === "Stopped";
  const isWaitingAck = remState.status === "WaitingAck";

  // Settings are only editable when the timer is fully stopped.
  const canEdit = isStopped;

  // Show the snooze button when the timer is active or a reminder just fired.
  const showSnooze = !isStopped && (showSnoozeBanner || isRunning || isPaused || isWaitingAck);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="app">
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

        {/* Snooze button – shown when timer is active (but not WaitingAck, which has its own card) */}
        {showSnooze && !isWaitingAck && (
          <button
            className="btn btn-snooze"
            onClick={handleSnooze}
            aria-label={`Snooze reminder for ${remState.config.snooze_minutes} minutes`}
          >
            💤 Snooze ({remState.config.snooze_minutes} min)
          </button>
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
            {canEdit
              ? "Settings are saved automatically as you type."
              : "Stop the timer to change settings."}
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
              disabled={!canEdit}
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
            <fieldset disabled={!canEdit}>
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
                    disabled={isInfinite}
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
              disabled={!canEdit}
              onChange={(e) =>
                setFormSnooze(Math.max(1, parseInt(e.target.value) || 1))
              }
              aria-describedby="snooze-desc"
            />
            <span id="snooze-desc" className="field-hint">
              How long to delay the reminder when you snooze it (1–60 min).
            </span>
          </div>

          {/* Notification behaviour toggles */}
          <div className="form-group">
            <fieldset disabled={!canEdit}>
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
                    checked={formFocusWindow}
                    onChange={(e) => setFormFocusWindow(e.target.checked)}
                  />
                  <span>Bring window to front</span>
                </label>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={formFlashTaskbar}
                    onChange={(e) => setFormFlashTaskbar(e.target.checked)}
                  />
                  <span>Flash taskbar / dock icon</span>
                </label>
              </div>
            </fieldset>
          </div>
        </div>
      </section>
    </div>
  );
}

export default App;
