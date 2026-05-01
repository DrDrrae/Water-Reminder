// components/SettingsCard.tsx — collapsible settings panel with all form fields.

import type { UseFormConfigResult } from "../hooks/useFormConfig";

interface Props {
  form: UseFormConfigResult;
  canEditTimingSettings: boolean;
  isStopped: boolean;
  settingsOpen: boolean;
  onToggleSettings: () => void;
}

export function SettingsCard({
  form,
  canEditTimingSettings,
  isStopped,
  settingsOpen,
  onToggleSettings,
}: Props) {
  return (
    <section className="card settings-card" aria-label="Reminder settings">
      <div className="settings-header">
        <h2 id="settings-title">Settings</h2>
        <button
          type="button"
          className="settings-toggle"
          onClick={onToggleSettings}
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
          {isStopped
            ? "All settings are saved automatically as you type."
            : "Theme, startup, and notification settings save automatically during active reminders. Stop the timer to change interval, max reminders, or snooze duration."}
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
            value={form.formInterval}
            disabled={!canEditTimingSettings}
            onChange={(e) =>
              form.setFormInterval(Math.max(1, parseInt(e.target.value) || 1))
            }
            aria-describedby="interval-desc"
          />
          <span id="interval-desc" className="field-hint">
            How frequently you want to be reminded (1–1440 min).
          </span>
        </div>

        {/* Max reminders */}
        <div className="form-group">
          <fieldset disabled={!canEditTimingSettings}>
            <legend>Maximum Reminders</legend>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  name="max-count"
                  checked={form.isInfinite}
                  onChange={() => form.setIsInfinite(true)}
                />
                Infinite (never stop automatically)
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="max-count"
                  checked={!form.isInfinite}
                  onChange={() => form.setIsInfinite(false)}
                />
                Limited:&nbsp;
                <input
                  type="number"
                  min={1}
                  max={9999}
                  value={form.formMaxCount}
                  disabled={form.isInfinite || !canEditTimingSettings}
                  className="inline-number"
                  aria-label="Maximum reminder count"
                  onChange={(e) =>
                    form.setFormMaxCount(Math.max(1, parseInt(e.target.value) || 1))
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
            value={form.formSnooze}
            disabled={!canEditTimingSettings}
            onChange={(e) =>
              form.setFormSnooze(Math.max(1, parseInt(e.target.value) || 1))
            }
            aria-describedby="snooze-desc"
          />
          <span id="snooze-desc" className="field-hint">
            How long to delay the reminder when you snooze it (1–60 min).
          </span>
        </div>

        {/* Theme */}
        <div className="form-group">
          <fieldset>
            <legend>Theme</legend>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  name="theme-preference"
                  checked={form.formThemePreference === "System"}
                  onChange={() => form.setFormThemePreference("System")}
                />
                <span>Follow system setting</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="theme-preference"
                  checked={form.formThemePreference === "AlwaysLight"}
                  onChange={() => form.setFormThemePreference("AlwaysLight")}
                />
                <span>Always light</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="theme-preference"
                  checked={form.formThemePreference === "AlwaysDark"}
                  onChange={() => form.setFormThemePreference("AlwaysDark")}
                />
                <span>Always dark</span>
              </label>
            </div>
          </fieldset>
          <span className="field-hint">
            The reminder flash still desaturates the UI; in dark mode it brightens instead of darkening.
          </span>
        </div>

        {/* Startup */}
        <div className="form-group">
          <fieldset>
            <legend>Startup</legend>
            <div className="toggle-group">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={form.formAutoStart}
                  onChange={(e) => form.setFormAutoStart(e.target.checked)}
                />
                <span>Automatically start reminders when the app launches</span>
              </label>
            </div>
          </fieldset>
          <span className="field-hint">
            When enabled, launch starts a fresh reminder session using your saved settings.
          </span>
        </div>

        {/* Notification behaviour */}
        <div className="form-group">
          <fieldset>
            <legend>Notification Behavior</legend>
            <div className="toggle-group">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={form.formRequireAck}
                  onChange={(e) => form.setFormRequireAck(e.target.checked)}
                />
                <span>Require acknowledgment before next reminder</span>
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={form.formPlaySound}
                  onChange={(e) => form.setFormPlaySound(e.target.checked)}
                />
                <span>Play alert sound</span>
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={form.formRepeatSoundUntilAction}
                  onChange={(e) => form.setFormRepeatSoundUntilAction(e.target.checked)}
                />
                <span>Repeat sound every 10 seconds until acknowledged or snoozed</span>
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={form.formFocusWindow}
                  onChange={(e) => form.setFormFocusWindow(e.target.checked)}
                />
                <span>Bring window to front (without focus on Windows)</span>
              </label>
              <label
                className={`toggle-label${!form.formFocusWindow ? " toggle-label--disabled" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={form.formAlwaysOnTopWhileWaiting}
                  disabled={!form.formFocusWindow}
                  onChange={(e) => form.setFormAlwaysOnTopWhileWaiting(e.target.checked)}
                />
                <span>Keep window always on top while waiting for acknowledgment</span>
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={form.formFlashTaskbar}
                  onChange={(e) => form.setFormFlashTaskbar(e.target.checked)}
                />
                <span>Flash taskbar / dock icon</span>
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={form.formMinimizeOnAcknowledge}
                  onChange={(e) => form.setFormMinimizeOnAcknowledge(e.target.checked)}
                />
                <span>Minimize window when starting, resuming, snoozing, or acknowledging reminders</span>
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={form.formKeepAwake}
                  onChange={(e) => form.setFormKeepAwake(e.target.checked)}
                />
                <span>Prevent system sleep while session is active (Windows)</span>
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={form.formMinimizeToTray}
                  onChange={(e) => form.setFormMinimizeToTray(e.target.checked)}
                />
                <span>Minimize to system tray instead of taskbar (Windows)</span>
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={form.formPauseOnLock}
                  onChange={(e) => form.setFormPauseOnLock(e.target.checked)}
                />
                <span>Pause timer when computer is locked, resume on unlock (Windows)</span>
              </label>
            </div>
          </fieldset>
          <span className="field-hint">
            These settings stay editable in all active reminder states and apply immediately.
          </span>
        </div>
      </div>
    </section>
  );
}
