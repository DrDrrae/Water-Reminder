// components/StatusCard.tsx — displays the current timer status, countdown,
// and reminder count.

import type { StateSnapshot } from "../types";
import { formatCountdown } from "../utils/format";

interface Props {
  remState: StateSnapshot;
}

export function StatusCard({ remState }: Props) {
  const isRunning = remState.status === "Running";
  const isPaused = remState.status === "Paused";
  const isStopped = remState.status === "Stopped";
  const isWaitingAck = remState.status === "WaitingAck";

  return (
    <section className="card status-card" aria-label="Current status">
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

      {(isRunning || isPaused) && (
        <div className="countdown" aria-label="Time until next reminder">
          <span className="countdown-label">Next reminder in</span>
          <span className="countdown-time">
            {isPaused ? "—paused—" : formatCountdown(remState.seconds_until_next)}
          </span>
        </div>
      )}

      <div className="reminder-counter" aria-label="Reminders sent">
        <span className="counter-number">{remState.reminder_count}</span>
        <span className="counter-label">
          {" "}reminder{remState.reminder_count !== 1 ? "s" : ""} sent
          {remState.config.max_count !== null && ` / ${remState.config.max_count} max`}
        </span>
      </div>
    </section>
  );
}
