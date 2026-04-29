// hooks/useBackendEvents.ts — subscribes to Tauri backend events and the
// window close request, managing flash and snooze-banner state internally.

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ReminderStatus, StateSnapshot } from "../types";
import { api } from "../api";
import { playAlertSound } from "../utils/audio";

interface Params {
  /** Current reminder status — kept in a ref so the close handler reads fresh data. */
  status: ReminderStatus;
  setRemState: Dispatch<SetStateAction<StateSnapshot>>;
  setError: Dispatch<SetStateAction<string | null>>;
  /** Ref from useFormConfig that always reflects the latest play_sound setting. */
  playSoundRef: MutableRefObject<boolean>;
}

export interface UseBackendEventsResult {
  isFlashing: boolean;
  showSnoozeBanner: boolean;
  setShowSnoozeBanner: Dispatch<SetStateAction<boolean>>;
  /** Stop the UI flash animation and cancel its auto-clear safety timer. */
  clearFlashEffect: () => void;
}

export function useBackendEvents({
  status,
  setRemState,
  setError,
  playSoundRef,
}: Params): UseBackendEventsResult {
  const [isFlashing, setIsFlashing] = useState(false);
  const [showSnoozeBanner, setShowSnoozeBanner] = useState(false);

  const snoozeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closePromptOpenRef = useRef(false);
  const closeInProgressRef = useRef(false);
  const reminderStatusRef = useRef<ReminderStatus>(status);

  // Keep reminderStatusRef fresh so the async close handler reads current status.
  useEffect(() => {
    reminderStatusRef.current = status;
  }, [status]);

  const clearFlashEffect = useCallback(() => {
    setIsFlashing(false);
    if (flashTimerRef.current !== null) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    const register = async () => {
      try {
        const reminderFiredUnlisten = await listen<number>("reminder-fired", () => {
          if (playSoundRef.current) playAlertSound();

          api
            .getStatus()
            .then(setRemState)
            .catch((e: unknown) => setError(String(e)));

          setShowSnoozeBanner(true);
          if (snoozeTimerRef.current !== null) clearTimeout(snoozeTimerRef.current);
          snoozeTimerRef.current = setTimeout(() => setShowSnoozeBanner(false), 30_000);

          setIsFlashing(true);
          if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
          flashTimerRef.current = setTimeout(() => setIsFlashing(false), 30_000);
        });
        if (disposed) { reminderFiredUnlisten(); return; }
        unlisteners.push(reminderFiredUnlisten);

        const reminderCompletedUnlisten = await listen<number>("reminder-completed", () => {
          api
            .getStatus()
            .then(setRemState)
            .catch((e: unknown) => setError(String(e)));
          setShowSnoozeBanner(false);
          clearFlashEffect();
        });
        if (disposed) { reminderCompletedUnlisten(); return; }
        unlisteners.push(reminderCompletedUnlisten);

        const lockStateChangedUnlisten = await listen<StateSnapshot>("lock-state-changed", (e) => {
          setRemState(e.payload);
        });
        if (disposed) { lockStateChangedUnlisten(); return; }
        unlisteners.push(lockStateChangedUnlisten);

        const closeUnlisten = await appWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          if (closeInProgressRef.current || closePromptOpenRef.current) return;

          const currentStatus = reminderStatusRef.current;
          const hasActiveSession =
            currentStatus === "Running" ||
            currentStatus === "Paused" ||
            currentStatus === "WaitingAck";

          if (!hasActiveSession) {
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
              { title: "Close Water Reminder?", kind: "warning" },
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
        if (disposed) { closeUnlisten(); return; }
        unlisteners.push(closeUnlisten);
      } catch (e) {
        console.error("[water-reminder] Failed to register app window listeners:", e);
      }
    };

    void register();

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
      if (snoozeTimerRef.current !== null) clearTimeout(snoozeTimerRef.current);
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    };
  }, [clearFlashEffect, playSoundRef, setError, setRemState]);

  return { isFlashing, showSnoozeBanner, setShowSnoozeBanner, clearFlashEffect };
}
