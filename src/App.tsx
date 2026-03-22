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
}

/** Possible states of the reminder timer. */
type ReminderStatus = "Stopped" | "Running" | "Paused";

/** Full state snapshot returned by backend commands. */
interface StateSnapshot {
  status: ReminderStatus;
  config: ReminderConfig;
  reminder_count: number;
  /** Seconds until the next reminder fires. null when not running. */
  seconds_until_next: number | null;
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

/** Default config values used when the app first loads. */
const DEFAULT_CONFIG: ReminderConfig = {
  interval_minutes: 60,
  max_count: null,
  snooze_minutes: 5,
};

/** Default state when the app first loads. */
const DEFAULT_STATE: StateSnapshot = {
  status: "Stopped",
  config: DEFAULT_CONFIG,
  reminder_count: 0,
  seconds_until_next: null,
};

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

  // Whether to show the snooze button prominently (set true after a reminder fires).
  const [showSnoozeBanner, setShowSnoozeBanner] = useState(false);

  // Latest error message to show to the user.
  const [error, setError] = useState<string | null>(null);

  // Ref to store the snooze-banner auto-hide timer so we can cancel it.
  const snoozeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // Load initial state from the backend on first render
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
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  // ---------------------------------------------------------------------------
  // Subscribe to backend events
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    // Fired each time a reminder notification is sent.
    listen<number>("reminder-fired", (_e) => {
      // Refresh full state so the count and countdown are accurate.
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
  // countdown display in sync.
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
    snooze_minutes: formSnooze,
  }), [formInterval, isInfinite, formMaxCount, formSnooze]);

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

  /** Stop the reminder timer completely. */
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

  /** Toggle between Paused and Running. */
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

  // ---------------------------------------------------------------------------
  // Derived state flags used to drive the UI
  // ---------------------------------------------------------------------------
  const isRunning = remState.status === "Running";
  const isPaused = remState.status === "Paused";
  const isStopped = remState.status === "Stopped";

  // Settings are only editable when the timer is fully stopped.
  const canEdit = isStopped;

  // Show the snooze button whenever the timer is active (running/paused) or
  // the snooze banner is triggered by a recent notification.
  const showSnooze = !isStopped && (showSnoozeBanner || isRunning || isPaused);

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
        {/* Running / Paused / Stopped badge */}
        <div
          className={`status-badge status-${remState.status.toLowerCase()}`}
          role="status"
          aria-live="polite"
        >
          {isRunning && "🟢 Running"}
          {isPaused && "⏸ Paused"}
          {isStopped && "⏹ Stopped"}
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

      {/* ── Settings card ── */}
      <section className="card settings-card" aria-label="Reminder settings">
        <h2>Settings</h2>
        <p className="settings-hint">
          {canEdit
            ? "Configure your reminder preferences below."
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
      </section>

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
            disabled={isRunning || isPaused}
            aria-label="Start reminders"
          >
            ▶ Start
          </button>

          {/* Pause / Resume – toggles between the two states */}
          <button
            className="btn btn-pause"
            onClick={handlePauseResume}
            disabled={isStopped}
            aria-label={isPaused ? "Resume reminders" : "Pause reminders"}
          >
            {isPaused ? "▶ Resume" : "⏸ Pause"}
          </button>

          {/* Stop – disabled when already stopped */}
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

        {/* Snooze button – shown when timer is active */}
        {showSnooze && (
          <button
            className="btn btn-snooze"
            onClick={handleSnooze}
            aria-label={`Snooze reminder for ${remState.config.snooze_minutes} minutes`}
          >
            💤 Snooze ({remState.config.snooze_minutes} min)
          </button>
        )}
      </section>
    </div>
  );
}

export default App;
