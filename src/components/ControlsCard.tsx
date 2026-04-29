// components/ControlsCard.tsx — start/stop/pause/reset buttons, running-state
// secondary actions, and the error banner.

import type { StateSnapshot } from "../types";

interface Props {
  remState: StateSnapshot;
  error: string | null;
  onDismissError: () => void;
  onStart: () => void;
  onStop: () => void;
  onPauseResume: () => void;
  onReset: () => void;
  onSnooze: () => void;
  onDrinkWater: () => void;
  showSnooze: boolean;
}

export function ControlsCard({
  remState,
  error,
  onDismissError,
  onStart,
  onStop,
  onPauseResume,
  onReset,
  onSnooze,
  onDrinkWater,
  showSnooze,
}: Props) {
  const isRunning = remState.status === "Running";
  const isPaused = remState.status === "Paused";
  const isStopped = remState.status === "Stopped";
  const isWaitingAck = remState.status === "WaitingAck";

  return (
    <section className="card controls-card" aria-label="Timer controls">
      {error && (
        <div className="error-banner" role="alert" aria-live="assertive">
          <span>⚠️ {error}</span>
          <button
            className="error-dismiss"
            onClick={onDismissError}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      <div className="button-grid">
        <button
          className="btn btn-start"
          onClick={onStart}
          disabled={isRunning || isPaused || isWaitingAck}
          aria-label="Start reminders"
        >
          ▶ Start
        </button>

        <button
          className="btn btn-pause"
          onClick={onPauseResume}
          disabled={isStopped || isWaitingAck}
          aria-label={isPaused ? "Resume reminders" : "Pause reminders"}
        >
          {isPaused ? "▶ Resume" : "⏸ Pause"}
        </button>

        <button
          className="btn btn-stop"
          onClick={onStop}
          disabled={isStopped}
          aria-label="Stop reminders"
        >
          ⏹ Stop
        </button>

        <button className="btn btn-reset" onClick={onReset} aria-label="Reset reminders">
          ↺ Reset
        </button>
      </div>

      {!isWaitingAck && (
        <div className="secondary-actions">
          <button
            className="btn btn-acknowledge"
            onClick={onDrinkWater}
            disabled={!isRunning}
            aria-label="I drank water and want to restart the reminder interval"
          >
            ✓ I Drank Water!
          </button>

          {showSnooze && (
            <button
              className="btn btn-snooze"
              onClick={onSnooze}
              aria-label={`Snooze reminder for ${remState.config.snooze_minutes} minutes`}
            >
              💤 Snooze ({remState.config.snooze_minutes} min)
            </button>
          )}
        </div>
      )}
    </section>
  );
}
