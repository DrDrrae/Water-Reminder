// hooks/useCountdownPoll.ts — polls the backend every second while Running
// to keep the countdown display in sync.

import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { ReminderStatus, StateSnapshot } from "../types";
import { api } from "../api";

/** Polls get_status every second when status is "Running"; stops otherwise. */
export function useCountdownPoll(
  status: ReminderStatus,
  setRemState: Dispatch<SetStateAction<StateSnapshot>>,
  setError: Dispatch<SetStateAction<string | null>>,
): void {
  useEffect(() => {
    if (status !== "Running") return;

    const id = setInterval(() => {
      api
        .getStatus()
        .then(setRemState)
        .catch((e: unknown) => setError(String(e)));
    }, 1_000);

    return () => clearInterval(id);
  }, [status, setRemState, setError]);
}
