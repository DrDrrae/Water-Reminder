// platform/mod.rs — platform-agnostic wrappers for all OS-integration calls.
//
// On Windows these forward to the `windows` sub-module which holds all the
// actual Win32 code.  On non-Windows targets the functions are no-ops so the
// rest of the codebase remains `#[cfg]`-free.

#[cfg(target_os = "windows")]
pub(crate) mod windows;

use tauri::AppHandle;

// ── One-time setup ────────────────────────────────────────────────────────────

pub(crate) fn setup(app_handle: &AppHandle, state: &crate::state::SharedState) {
    #[cfg(target_os = "windows")]
    windows::setup(app_handle, state);

    #[cfg(not(target_os = "windows"))]
    let _ = (app_handle, state);
}

// ── Config sync ───────────────────────────────────────────────────────────────

pub(crate) fn sync_minimize_to_tray_state(app_handle: &AppHandle, enabled: bool) {
    #[cfg(target_os = "windows")]
    windows::sync_minimize_to_tray_state(app_handle, enabled);

    #[cfg(not(target_os = "windows"))]
    let _ = (app_handle, enabled);
}

pub(crate) fn sync_pause_on_lock_state(enabled: bool) {
    #[cfg(target_os = "windows")]
    windows::sync_pause_on_lock_state(enabled);

    #[cfg(not(target_os = "windows"))]
    let _ = enabled;
}

pub(crate) fn clear_auto_pause_flag() {
    #[cfg(target_os = "windows")]
    windows::clear_auto_pause_flag();
}

// ── Window management ─────────────────────────────────────────────────────────

pub(crate) fn bring_window_to_front(app_handle: &AppHandle) {
    #[cfg(target_os = "windows")]
    windows::bring_window_to_front(app_handle);

    #[cfg(not(target_os = "windows"))]
    let _ = app_handle;
}

pub(crate) fn restore_window_from_tray(app_handle: &AppHandle) {
    #[cfg(target_os = "windows")]
    windows::restore_window_from_tray(app_handle);

    #[cfg(not(target_os = "windows"))]
    let _ = app_handle;
}

pub(crate) fn minimize_window(app_handle: &AppHandle) {
    #[cfg(target_os = "windows")]
    windows::minimize_window(app_handle);

    #[cfg(not(target_os = "windows"))]
    let _ = app_handle;
}

// ── Taskbar attention ─────────────────────────────────────────────────────────

pub(crate) fn flash_window_taskbar(app_handle: &AppHandle) {
    #[cfg(target_os = "windows")]
    windows::flash_window_taskbar(app_handle);

    #[cfg(not(target_os = "windows"))]
    let _ = app_handle;
}

pub(crate) fn stop_window_attention(app_handle: &AppHandle) {
    #[cfg(target_os = "windows")]
    windows::stop_window_attention(app_handle);

    #[cfg(not(target_os = "windows"))]
    let _ = app_handle;
}

// ── Wake lock ─────────────────────────────────────────────────────────────────

pub(crate) fn activate_wake_lock(app_handle: &AppHandle) {
    #[cfg(target_os = "windows")]
    windows::activate_wake_lock(app_handle);

    #[cfg(not(target_os = "windows"))]
    let _ = app_handle;
}

pub(crate) fn deactivate_wake_lock(app_handle: &AppHandle) {
    #[cfg(target_os = "windows")]
    windows::deactivate_wake_lock(app_handle);

    #[cfg(not(target_os = "windows"))]
    let _ = app_handle;
}
