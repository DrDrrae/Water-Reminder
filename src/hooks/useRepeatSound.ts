// hooks/useRepeatSound.ts — plays the alert sound on a repeat interval while
// the app is waiting for acknowledgment.

import { useEffect, useRef } from "react";
import type { ReminderStatus } from "../types";
import { playAlertSound } from "../utils/audio";
import { ALERT_REPEAT_INTERVAL_MS } from "../constants";

/** Starts/stops the repeat-sound interval based on status and user settings. */
export function useRepeatSound(
  status: ReminderStatus,
  playSound: boolean,
  repeatSoundUntilAction: boolean,
): void {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (status !== "WaitingAck" || !playSound || !repeatSoundUntilAction) return;

    timerRef.current = setInterval(playAlertSound, ALERT_REPEAT_INTERVAL_MS);

    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status, playSound, repeatSoundUntilAction]);
}
