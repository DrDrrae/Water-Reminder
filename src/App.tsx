import { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { ReminderStatus, StateSnapshot } from "./types";
import { DEFAULT_STATE } from "./constants";
import { api } from "./api";
import { useFormConfig } from "./hooks/useFormConfig";
import { useBackendEvents } from "./hooks/useBackendEvents";
import { useTheme } from "./hooks/useTheme";
import { useRepeatSound } from "./hooks/useRepeatSound";
import { useCountdownPoll } from "./hooks/useCountdownPoll";
import { StatusCard } from "./components/StatusCard";
import { AcknowledgeCard } from "./components/AcknowledgeCard";
import { ControlsCard } from "./components/ControlsCard";
import { SettingsCard } from "./components/SettingsCard";

function App() {
  const [remState, setRemState] = useState<StateSnapshot>(DEFAULT_STATE);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(true);

  const form = useFormConfig({ setRemState, setError });
  useTheme(form.formThemePreference);

  const { isFlashing, showSnoozeBanner, setShowSnoozeBanner, clearFlashEffect } =
    useBackendEvents({ status: remState.status, setRemState, setError, playSoundRef: form.playSoundRef });

  useRepeatSound(remState.status, form.formPlaySound, form.formRepeatSoundUntilAction);
  useCountdownPoll(remState.status, setRemState, setError);

  // Load initial state from the backend; populate the form from persisted config.
  useEffect(() => {
    api
      .getStatus()
      .then((snap) => {
        setRemState(snap);
        form.applySnapshot(snap.config);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Always-on-top: managed in the frontend so it tracks React state precisely.
  // Skip Tauri's setAlwaysOnTop(false) when tray-hiding would cause tao to re-show the window.
  useEffect(() => {
    if (
      remState.status !== "WaitingAck" ||
      !form.formFocusWindow ||
      !form.formAlwaysOnTopWhileWaiting
    ) {
      return;
    }
    const appWindow = getCurrentWindow();
    void appWindow.setAlwaysOnTop(true);
    return () => {
      // tao calls ShowWindow(SW_SHOW) on setAlwaysOnTop(false) when its visibility
      // cache is stale from our direct SW_HIDE; skip if tray-hide is about to happen.
      if (form.formMinimizeToTray && form.formMinimizeOnAcknowledge) return;
      void appWindow.setAlwaysOnTop(false);
    };
  }, [
    remState.status,
    form.formFocusWindow,
    form.formAlwaysOnTopWhileWaiting,
    form.formMinimizeToTray,
    form.formMinimizeOnAcknowledge,
  ]);

  // React to status transitions: collapse settings on start, clear flash/snooze on ack.
  const previousStatusRef = useRef<ReminderStatus>(DEFAULT_STATE.status);
  useEffect(() => {
    const prev = previousStatusRef.current;
    if (prev === "WaitingAck" && remState.status !== "WaitingAck") {
      setShowSnoozeBanner(false);
      clearFlashEffect();
    }
    if (prev === "Stopped" && remState.status === "Running") {
      setSettingsOpen(false);
    }
    previousStatusRef.current = remState.status;
  }, [clearFlashEffect, remState.status, setShowSnoozeBanner]);

  // Special case: if the user unchecks requireAck while in WaitingAck, bypass the
  // debounce and save immediately so the backend exits WaitingAck right away.
  useEffect(() => {
    if (
      form.isInitialLoadRef.current ||
      remState.status !== "WaitingAck" ||
      form.formRequireAck ||
      !remState.config.require_acknowledgment
    ) {
      return;
    }
    if (form.autosaveTimerRef.current !== null) {
      clearTimeout(form.autosaveTimerRef.current);
      form.autosaveTimerRef.current = null;
    }
    api
      .saveConfig(form.buildConfig())
      .then(setRemState)
      .catch((e: unknown) => setError(String(e)));
  }, [form, remState.config.require_acknowledgment, remState.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------
  const isRunning = remState.status === "Running";
  const isPaused = remState.status === "Paused";
  const isStopped = remState.status === "Stopped";
  const isWaitingAck = remState.status === "WaitingAck";
  const showSnooze = !isStopped && (showSnoozeBanner || isRunning || isPaused || isWaitingAck);

  // ---------------------------------------------------------------------------
  // Command handlers
  // ---------------------------------------------------------------------------
  const handleStart = useCallback(async () => {
    setError(null);
    try { setRemState(await api.startReminders(form.buildConfig())); }
    catch (e) { setError(String(e)); }
  }, [form]);

  const handleStop = useCallback(async () => {
    setError(null);
    try {
      setRemState(await api.stopReminders());
      setShowSnoozeBanner(false);
      clearFlashEffect();
    } catch (e) { setError(String(e)); }
  }, [clearFlashEffect, setShowSnoozeBanner]);

  const handlePauseResume = useCallback(async () => {
    setError(null);
    try {
      setRemState(await (remState.status === "Running" ? api.pauseReminders() : api.resumeReminders()));
    } catch (e) { setError(String(e)); }
  }, [remState.status]);

  const handleReset = useCallback(async () => {
    setError(null);
    try {
      setRemState(await api.resetReminders());
      setShowSnoozeBanner(false);
      clearFlashEffect();
    } catch (e) { setError(String(e)); }
  }, [clearFlashEffect, setShowSnoozeBanner]);

  const handleSnooze = useCallback(async () => {
    setError(null);
    try {
      setRemState(await api.snoozeReminder());
      setShowSnoozeBanner(false);
      clearFlashEffect();
    } catch (e) { setError(String(e)); }
  }, [clearFlashEffect, setShowSnoozeBanner]);

  const handleAcknowledge = useCallback(async () => {
    setError(null);
    try {
      setRemState(await api.acknowledgeReminder());
      setShowSnoozeBanner(false);
      clearFlashEffect();
    } catch (e) { setError(String(e)); }
  }, [clearFlashEffect, setShowSnoozeBanner]);

  const handleDrinkWater = useCallback(async () => {
    setError(null);
    try {
      setRemState(await api.resetActiveCountdown());
      setShowSnoozeBanner(false);
      clearFlashEffect();
    } catch (e) { setError(String(e)); }
  }, [clearFlashEffect, setShowSnoozeBanner]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className={`app${isFlashing ? " app--flashing" : ""}`}>
      <header className="app-header">
        <div className="header-icon" aria-hidden="true">💧</div>
        <h1>Water Reminder</h1>
        <p className="tagline">Stay hydrated, stay healthy!</p>
      </header>

      <StatusCard remState={remState} />

      {isWaitingAck && (
        <AcknowledgeCard
          remState={remState}
          onAcknowledge={handleAcknowledge}
          onSnooze={handleSnooze}
        />
      )}

      <ControlsCard
        remState={remState}
        error={error}
        onDismissError={() => setError(null)}
        onStart={handleStart}
        onStop={handleStop}
        onPauseResume={handlePauseResume}
        onReset={handleReset}
        onSnooze={handleSnooze}
        onDrinkWater={handleDrinkWater}
        showSnooze={showSnooze}
      />

      <SettingsCard
        form={form}
        canEditTimingSettings={isStopped}
        isStopped={isStopped}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((o) => !o)}
      />
    </div>
  );
}

export default App;
