// store.rs — settings persistence via tauri-plugin-store.

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::state::ReminderConfig;

const STORE_FILE: &str = "settings.json";
const STORE_KEY_CONFIG: &str = "config";

/// Persist `config` to the on-disk store.
///
/// Errors are logged but not propagated so that a failed write never prevents
/// the user from continuing to use the app.
pub fn persist_config(app_handle: &AppHandle, config: &ReminderConfig) {
    match app_handle.store(STORE_FILE) {
        Ok(store) => match serde_json::to_value(config) {
            Ok(value) => {
                store.set(STORE_KEY_CONFIG, value);
                if let Err(e) = store.save() {
                    eprintln!("[water-reminder] Failed to save config: {e}");
                }
            }
            Err(e) => eprintln!("[water-reminder] Failed to serialise config: {e}"),
        },
        Err(e) => eprintln!("[water-reminder] Failed to open store: {e}"),
    }
}

/// Try to load a previously saved `ReminderConfig` from the on-disk store.
/// Returns `None` if no config has been saved yet or if it cannot be parsed.
pub fn load_config(app_handle: &AppHandle) -> Option<ReminderConfig> {
    let store = app_handle.store(STORE_FILE).ok()?;
    let value = store.get(STORE_KEY_CONFIG)?;
    serde_json::from_value::<ReminderConfig>(value).ok()
}
