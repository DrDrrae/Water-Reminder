// components/AcknowledgeCard.tsx — shown when a reminder is waiting for the
// user to confirm they have drunk water.

import type { StateSnapshot } from "../types";

interface Props {
  remState: StateSnapshot;
  onAcknowledge: () => void;
  onSnooze: () => void;
}

export function AcknowledgeCard({ remState, onAcknowledge, onSnooze }: Props) {
  return (
    <section className="card ack-card" aria-live="assertive" aria-label="Reminder acknowledgment">
      <div className="ack-icon" aria-hidden="true">💧</div>
      <h2 className="ack-title">Time to Drink Water!</h2>
      <p className="ack-subtitle">
        Take a moment to hydrate before your next reminder starts.
      </p>
      <div className="ack-buttons">
        <button
          className="btn btn-acknowledge"
          onClick={onAcknowledge}
          aria-label="Acknowledge – I drank water, start the next reminder interval"
        >
          ✓ I Drank Water!
        </button>
        <button
          className="btn btn-snooze"
          onClick={onSnooze}
          aria-label={`Snooze reminder for ${remState.config.snooze_minutes} minutes`}
        >
          💤 Snooze ({remState.config.snooze_minutes} min)
        </button>
      </div>
    </section>
  );
}
