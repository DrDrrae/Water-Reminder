// hooks/useFormConfig.ts — manages all 15 settings form fields, auto-save, and
// config serialisation. Owns the debounce timer and initial-load flag.

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ReminderConfig, StateSnapshot, ThemePreference } from "../types";
import { DEFAULT_CONFIG, AUTOSAVE_DEBOUNCE_MS } from "../constants";
import { api } from "../api";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface FormValues {
  formInterval: number;
  formSnooze: number;
  isInfinite: boolean;
  formMaxCount: number;
  formThemePreference: ThemePreference;
  formAutoStart: boolean;
  formRequireAck: boolean;
  formPlaySound: boolean;
  formRepeatSoundUntilAction: boolean;
  formFocusWindow: boolean;
  formFlashTaskbar: boolean;
  formMinimizeOnAcknowledge: boolean;
  formAlwaysOnTopWhileWaiting: boolean;
  formKeepAwake: boolean;
  formMinimizeToTray: boolean;
  formPauseOnLock: boolean;
}

export interface UseFormConfigResult extends FormValues {
  setFormInterval: Dispatch<SetStateAction<number>>;
  setFormSnooze: Dispatch<SetStateAction<number>>;
  setIsInfinite: Dispatch<SetStateAction<boolean>>;
  setFormMaxCount: Dispatch<SetStateAction<number>>;
  setFormThemePreference: Dispatch<SetStateAction<ThemePreference>>;
  setFormAutoStart: Dispatch<SetStateAction<boolean>>;
  setFormRequireAck: Dispatch<SetStateAction<boolean>>;
  setFormPlaySound: Dispatch<SetStateAction<boolean>>;
  setFormRepeatSoundUntilAction: Dispatch<SetStateAction<boolean>>;
  setFormFocusWindow: Dispatch<SetStateAction<boolean>>;
  setFormFlashTaskbar: Dispatch<SetStateAction<boolean>>;
  setFormMinimizeOnAcknowledge: Dispatch<SetStateAction<boolean>>;
  setFormAlwaysOnTopWhileWaiting: Dispatch<SetStateAction<boolean>>;
  setFormKeepAwake: Dispatch<SetStateAction<boolean>>;
  setFormMinimizeToTray: Dispatch<SetStateAction<boolean>>;
  setFormPauseOnLock: Dispatch<SetStateAction<boolean>>;
  /** Build a ReminderConfig from current form values. */
  buildConfig: () => ReminderConfig;
  /** Populate all form fields from a config snapshot (called after initial load). */
  applySnapshot: (config: ReminderConfig) => void;
  /** true during initial backend load; prevents autosave on mount. */
  isInitialLoadRef: MutableRefObject<boolean>;
  /** Active debounce timer id; exposed so App.tsx can cancel it for the requireAck special-case. */
  autosaveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  /** Mirrors formPlaySound for stale-closure-safe access in event listeners. */
  playSoundRef: MutableRefObject<boolean>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface Params {
  setRemState: Dispatch<SetStateAction<StateSnapshot>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

export function useFormConfig({ setRemState, setError }: Params): UseFormConfigResult {
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
  const [formKeepAwake, setFormKeepAwake] = useState(DEFAULT_CONFIG.keep_awake);
  const [formMinimizeToTray, setFormMinimizeToTray] = useState(DEFAULT_CONFIG.minimize_to_tray);
  const [formPauseOnLock, setFormPauseOnLock] = useState(DEFAULT_CONFIG.pause_on_lock);

  const isInitialLoadRef = useRef(true);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playSoundRef = useRef(DEFAULT_CONFIG.play_sound);

  // Keep playSoundRef in sync so one-time-mounted event listeners read the latest value.
  useEffect(() => {
    playSoundRef.current = formPlaySound;
  }, [formPlaySound]);

  const buildConfig = useCallback(
    (): ReminderConfig => ({
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
      keep_awake: formKeepAwake,
      minimize_to_tray: formMinimizeToTray,
      pause_on_lock: formPauseOnLock,
    }),
    [
      formInterval, isInfinite, formMaxCount, formThemePreference, formSnooze,
      formAutoStart, formRequireAck, formPlaySound, formRepeatSoundUntilAction,
      formFocusWindow, formFlashTaskbar, formMinimizeOnAcknowledge,
      formAlwaysOnTopWhileWaiting, formKeepAwake, formMinimizeToTray, formPauseOnLock,
    ],
  );

  const applySnapshot = useCallback((config: ReminderConfig) => {
    setFormInterval(config.interval_minutes);
    setFormSnooze(config.snooze_minutes);
    setIsInfinite(config.max_count === null);
    setFormMaxCount(config.max_count ?? 10);
    setFormThemePreference(config.theme_preference);
    setFormAutoStart(config.auto_start);
    setFormRequireAck(config.require_acknowledgment);
    setFormPlaySound(config.play_sound);
    setFormRepeatSoundUntilAction(config.repeat_sound_until_action);
    setFormFocusWindow(config.focus_window);
    setFormFlashTaskbar(config.flash_taskbar);
    setFormMinimizeOnAcknowledge(config.minimize_on_acknowledge);
    setFormAlwaysOnTopWhileWaiting(config.always_on_top_while_waiting);
    setFormKeepAwake(config.keep_awake);
    setFormMinimizeToTray(config.minimize_to_tray);
    setFormPauseOnLock(config.pause_on_lock);
    isInitialLoadRef.current = false;
  }, []);

  // Debounced auto-save — skip initial load, debounce subsequent changes.
  useEffect(() => {
    if (isInitialLoadRef.current) return;
    if (autosaveTimerRef.current !== null) clearTimeout(autosaveTimerRef.current);

    autosaveTimerRef.current = setTimeout(() => {
      api
        .saveConfig(buildConfig())
        .then(setRemState)
        .catch((e: unknown) => setError(String(e)));
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveTimerRef.current !== null) clearTimeout(autosaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    formInterval, formSnooze, isInfinite, formMaxCount, formThemePreference,
    formAutoStart, formRequireAck, formPlaySound, formRepeatSoundUntilAction,
    formFocusWindow, formFlashTaskbar, formMinimizeOnAcknowledge,
    formAlwaysOnTopWhileWaiting, formKeepAwake, formMinimizeToTray, formPauseOnLock,
  ]);

  return {
    formInterval, setFormInterval,
    formSnooze, setFormSnooze,
    isInfinite, setIsInfinite,
    formMaxCount, setFormMaxCount,
    formThemePreference, setFormThemePreference,
    formAutoStart, setFormAutoStart,
    formRequireAck, setFormRequireAck,
    formPlaySound, setFormPlaySound,
    formRepeatSoundUntilAction, setFormRepeatSoundUntilAction,
    formFocusWindow, setFormFocusWindow,
    formFlashTaskbar, setFormFlashTaskbar,
    formMinimizeOnAcknowledge, setFormMinimizeOnAcknowledge,
    formAlwaysOnTopWhileWaiting, setFormAlwaysOnTopWhileWaiting,
    formKeepAwake, setFormKeepAwake,
    formMinimizeToTray, setFormMinimizeToTray,
    formPauseOnLock, setFormPauseOnLock,
    buildConfig,
    applySnapshot,
    isInitialLoadRef,
    autosaveTimerRef,
    playSoundRef,
  };
}
