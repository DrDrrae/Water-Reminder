// platform/windows.rs — all Windows-specific OS integration.
//
// Contains:
//  • AtomicBool/AtomicIsize globals read by the WndProc bare function pointer
//  • WndProc subclassing for minimize-to-tray and WTS session notifications
//  • Win32 helpers: window surfacing, taskbar flash, wake lock, tray, VDesktop

use std::sync::{Arc, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::state::{
    ReminderStatus, SharedState, interval_duration, snapshot,
};

// ── Globals (readable from the bare WndProc function pointer) ─────────────────

/// `true` while the user has "minimize to tray" enabled.
pub(crate) static MINIMIZE_TO_TRAY: AtomicBool = AtomicBool::new(false);

/// The original window procedure, saved for forwarding unhandled messages.
pub(crate) static ORIGINAL_WNDPROC: AtomicIsize = AtomicIsize::new(0);

/// `true` when auto-pause-on-lock is enabled in config.
pub(crate) static AUTO_PAUSE_ON_LOCK_ENABLED: AtomicBool = AtomicBool::new(false);

/// `true` when the timer was paused by a lock event (vs. user-initiated pause).
pub(crate) static AUTO_PAUSED_BY_LOCK: AtomicBool = AtomicBool::new(false);

/// Tracks the current session lock state to order lock/unlock events correctly.
pub(crate) static SESSION_IS_LOCKED: AtomicBool = AtomicBool::new(false);

/// Stored once during `setup` so the WndProc can access the app handle.
pub(crate) static GLOBAL_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Stored once during `setup` so the WndProc can access the shared timer state.
pub(crate) static GLOBAL_SHARED_STATE: OnceLock<SharedState> = OnceLock::new();

// ── One-time setup ────────────────────────────────────────────────────────────

/// Store globals needed by the WndProc and install the minimize hook.
/// Call once from the Tauri setup closure after the window is created.
pub(crate) fn setup(app_handle: &AppHandle, state: &SharedState) {
    let _ = GLOBAL_APP_HANDLE.set(app_handle.clone());
    let _ = GLOBAL_SHARED_STATE.set(Arc::clone(state));
    install_minimize_wndproc_hook(app_handle);
}

// ── Config sync helpers ───────────────────────────────────────────────────────

/// Update `MINIMIZE_TO_TRAY` and the tray-icon visibility to match config.
/// When the feature is turned off while the window might be hidden, restore it.
pub(crate) fn sync_minimize_to_tray_state(app_handle: &AppHandle, minimize_to_tray: bool) {
    let was_tray = MINIMIZE_TO_TRAY.swap(minimize_to_tray, Ordering::Relaxed);
    if let Some(tray) = app_handle.tray_by_id("main-tray") {
        let _ = tray.set_visible(minimize_to_tray);
    }
    if was_tray && !minimize_to_tray {
        if let Some(hwnd) = hwnd_from_main_window(app_handle) {
            let hwnd_val = hwnd as usize;
            let _ = app_handle.run_on_main_thread(move || {
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    IsWindowVisible, SW_SHOWNA, ShowWindow,
                };
                let hwnd = hwnd_val as windows_sys::Win32::Foundation::HWND;
                unsafe {
                    if IsWindowVisible(hwnd) == 0 {
                        ShowWindow(hwnd, SW_SHOWNA);
                    }
                }
            });
        }
    }
}

/// Update `AUTO_PAUSE_ON_LOCK_ENABLED` to match config.
pub(crate) fn sync_pause_on_lock_state(enabled: bool) {
    AUTO_PAUSE_ON_LOCK_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Clear the auto-pause flag so a future unlock does not resume a session
/// that was explicitly stopped by the user.
pub(crate) fn clear_auto_pause_flag() {
    AUTO_PAUSED_BY_LOCK.store(false, Ordering::Relaxed);
}

// ── Lock/unlock auto-pause helpers ────────────────────────────────────────────

/// Auto-pause the timer because the Windows session was locked.
pub(crate) fn auto_pause_for_lock(state: &SharedState, app_handle: &AppHandle) {
    if !SESSION_IS_LOCKED.load(Ordering::Acquire) {
        return;
    }

    let snap = {
        let mut s = match state.lock() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[water-reminder] auto_pause_for_lock: lock failed: {e}");
                return;
            }
        };
        if s.status != ReminderStatus::Running {
            return;
        }
        s.remaining_when_paused = s.next_fire_at.map(|t| {
            t.checked_duration_since(Instant::now())
                .unwrap_or(Duration::ZERO)
        });
        s.status = ReminderStatus::Paused;
        s.next_fire_at = None;
        s.thread_generation += 1;
        AUTO_PAUSED_BY_LOCK.store(true, Ordering::Release);
        snapshot(&s)
    };

    if let Err(e) = app_handle.emit("lock-state-changed", snap) {
        eprintln!("[water-reminder] auto_pause_for_lock: emit failed: {e}");
    }
}

use tauri::Emitter;

/// Auto-resume the timer because the Windows session was unlocked.
pub(crate) fn auto_resume_from_lock(state: &SharedState, app_handle: &AppHandle) {
    let (snap, my_gen) = {
        let mut s = match state.lock() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[water-reminder] auto_resume_from_lock: lock failed: {e}");
                AUTO_PAUSED_BY_LOCK.store(false, Ordering::Relaxed);
                return;
            }
        };
        if SESSION_IS_LOCKED.load(Ordering::Acquire) {
            return;
        }
        if AUTO_PAUSED_BY_LOCK
            .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        if s.status != ReminderStatus::Paused {
            return;
        }
        let remaining = s
            .remaining_when_paused
            .unwrap_or_else(|| interval_duration(&s.config));
        s.next_fire_at = Some(Instant::now() + remaining);
        s.remaining_when_paused = None;
        s.status = ReminderStatus::Running;
        s.thread_generation += 1;
        let my_gen = s.thread_generation;
        (snapshot(&s), my_gen)
    };

    crate::timer::spawn_timer_thread(Arc::clone(state), app_handle.clone(), my_gen);

    if let Err(e) = app_handle.emit("lock-state-changed", snap) {
        eprintln!("[water-reminder] auto_resume_from_lock: emit failed: {e}");
    }
}

// ── WndProc subclassing ───────────────────────────────────────────────────────

/// Window procedure that intercepts `WM_SYSCOMMAND/SC_MINIMIZE` for tray hiding
/// and `WM_WTSSESSION_CHANGE` for session lock/unlock notifications.
pub(crate) unsafe extern "system" fn minimize_intercept_wndproc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CallWindowProcW, GWLP_WNDPROC, SC_MINIMIZE, SW_HIDE, SetWindowLongPtrW, ShowWindow,
            WM_NCDESTROY, WM_SYSCOMMAND,
        };

        if msg == WM_SYSCOMMAND && (wparam & 0xFFF0) == SC_MINIMIZE as usize {
            if MINIMIZE_TO_TRAY.load(Ordering::Relaxed) {
                ShowWindow(hwnd, SW_HIDE);
                return 0;
            }
        }

        const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
        const WTS_SESSION_LOCK: usize = 7;
        const WTS_SESSION_UNLOCK: usize = 8;
        if msg == WM_WTSSESSION_CHANGE {
            if wparam == WTS_SESSION_LOCK && AUTO_PAUSE_ON_LOCK_ENABLED.load(Ordering::Relaxed) {
                SESSION_IS_LOCKED.store(true, Ordering::Release);
                if let (Some(handle), Some(state)) =
                    (GLOBAL_APP_HANDLE.get(), GLOBAL_SHARED_STATE.get())
                {
                    let handle = handle.clone();
                    let state = Arc::clone(state);
                    std::thread::spawn(move || auto_pause_for_lock(&state, &handle));
                }
            } else if wparam == WTS_SESSION_UNLOCK {
                SESSION_IS_LOCKED.store(false, Ordering::Release);
                if let (Some(handle), Some(state)) =
                    (GLOBAL_APP_HANDLE.get(), GLOBAL_SHARED_STATE.get())
                {
                    let handle = handle.clone();
                    let state = Arc::clone(state);
                    std::thread::spawn(move || auto_resume_from_lock(&state, &handle));
                }
            }
            return 0;
        }

        if msg == WM_NCDESTROY {
            use windows_sys::Win32::System::RemoteDesktop::WTSUnRegisterSessionNotification;
            WTSUnRegisterSessionNotification(hwnd);
            let orig = ORIGINAL_WNDPROC.load(Ordering::Relaxed);
            if orig != 0 {
                SetWindowLongPtrW(hwnd, GWLP_WNDPROC, orig);
            }
        }

        let orig = ORIGINAL_WNDPROC.load(Ordering::Relaxed);
        if orig == 0 {
            return 0;
        }

        type WndProcFn = unsafe extern "system" fn(
            windows_sys::Win32::Foundation::HWND,
            u32,
            windows_sys::Win32::Foundation::WPARAM,
            windows_sys::Win32::Foundation::LPARAM,
        ) -> windows_sys::Win32::Foundation::LRESULT;
        let orig_fn: WndProcFn = std::mem::transmute(orig as usize);
        CallWindowProcW(Some(orig_fn), hwnd, msg, wparam, lparam)
    }
}

/// Subclass the main window to intercept minimize requests and session notifications.
/// Safe to call only once; guarded by `ORIGINAL_WNDPROC`.
fn install_minimize_wndproc_hook(app_handle: &AppHandle) {
    use windows_sys::Win32::Foundation::{GetLastError, SetLastError};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GWLP_WNDPROC, GetWindowLongPtrW, SetWindowLongPtrW,
    };

    if ORIGINAL_WNDPROC.load(Ordering::Relaxed) != 0 {
        return;
    }

    let Some(hwnd) = hwnd_from_main_window(app_handle) else {
        eprintln!(
            "[water-reminder] Could not get HWND; OS minimize button will not redirect to tray."
        );
        return;
    };

    unsafe {
        let orig = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        if orig == 0 {
            eprintln!(
                "[water-reminder] GetWindowLongPtrW returned 0; cannot install minimize hook."
            );
            return;
        }
        ORIGINAL_WNDPROC.store(orig, Ordering::Relaxed);
        SetLastError(0);
        let prev = SetWindowLongPtrW(
            hwnd,
            GWLP_WNDPROC,
            minimize_intercept_wndproc as *const () as isize,
        );
        if prev == 0 {
            let err = GetLastError();
            if err != 0 {
                ORIGINAL_WNDPROC.store(0, Ordering::Relaxed);
                eprintln!(
                    "[water-reminder] SetWindowLongPtrW failed (error {err}); cannot install minimize hook."
                );
                return;
            }
        }

        use windows_sys::Win32::System::RemoteDesktop::{
            NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification,
        };
        if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) == 0 {
            let err = GetLastError();
            eprintln!(
                "[water-reminder] WTSRegisterSessionNotification failed (error {err}); \
                 auto-pause on lock will not work."
            );
        }
    }
}

// ── HWND helper ───────────────────────────────────────────────────────────────

pub(crate) fn hwnd_from_main_window(
    app_handle: &AppHandle,
) -> Option<windows_sys::Win32::Foundation::HWND> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Foundation::HWND;

    let Some(win) = app_handle.get_webview_window("main") else {
        return None;
    };

    let window_handle: raw_window_handle::WindowHandle<'_> = match win.window_handle() {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[water-reminder] Failed to get native window handle: {e}");
            return None;
        }
    };

    match window_handle.as_raw() {
        RawWindowHandle::Win32(h) => Some(h.hwnd.get() as HWND),
        _ => {
            eprintln!("[water-reminder] Unexpected non-Win32 window handle on Windows.");
            None
        }
    }
}

// ── Virtual desktop ───────────────────────────────────────────────────────────

/// Move the app window to the current active virtual desktop if it is on a
/// different one.  Uses `IVirtualDesktopManager` (Windows 10 1607+).
/// **Must be called from the main thread.**
pub(crate) fn move_to_current_virtual_desktop_main_thread(
    hwnd_sys: windows_sys::Win32::Foundation::HWND,
) {
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
    use windows::Win32::UI::Shell::IVirtualDesktopManager;
    use windows::core::GUID;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    const CLSID_VDM: GUID = GUID {
        data1: 0xAA509086,
        data2: 0x5CA9,
        data3: 0x4C25,
        data4: [0x8F, 0x95, 0x58, 0x9D, 0x3C, 0x07, 0xB4, 0x8A],
    };

    let main_hwnd = windows::Win32::Foundation::HWND(hwnd_sys);

    unsafe {
        let Ok(vdm): windows::core::Result<IVirtualDesktopManager> =
            CoCreateInstance(&CLSID_VDM, None, CLSCTX_ALL)
        else {
            return;
        };

        if let Ok(b) = vdm.IsWindowOnCurrentVirtualDesktop(main_hwnd) {
            if b.as_bool() {
                return;
            }
        }

        let fg_hwnd_sys = GetForegroundWindow();
        if fg_hwnd_sys.is_null() {
            return;
        }
        let fg_hwnd = windows::Win32::Foundation::HWND(fg_hwnd_sys);

        let Ok(desktop_id) = vdm.GetWindowDesktopId(fg_hwnd) else {
            return;
        };

        let _ = vdm.MoveWindowToDesktop(main_hwnd, &desktop_id);
    }
}

// ── Window surfacing ──────────────────────────────────────────────────────────

pub(crate) fn bring_window_to_front(app_handle: &AppHandle) {
    let Some(hwnd) = hwnd_from_main_window(app_handle) else {
        return;
    };
    let hwnd_val = hwnd as usize;

    if let Err(e) = app_handle.run_on_main_thread(move || {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            HWND_NOTOPMOST, HWND_TOPMOST, IsWindowVisible, SW_SHOWNOACTIVATE, SWP_NOACTIVATE,
            SWP_NOMOVE, SWP_NOSIZE, SetWindowPos, ShowWindow,
        };
        let hwnd = hwnd_val as windows_sys::Win32::Foundation::HWND;

        move_to_current_virtual_desktop_main_thread(hwnd);

        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            } else {
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }

            let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
            if SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags) == 0 {
                eprintln!("[water-reminder] Failed to raise reminder window to topmost.");
                return;
            }
            if SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags) == 0 {
                eprintln!("[water-reminder] Failed to restore reminder window to non-topmost.");
            }
        }
    }) {
        eprintln!("[water-reminder] bring_window_to_front: run_on_main_thread failed: {e}");
    }
}

pub(crate) fn restore_window_from_tray(app_handle: &AppHandle) {
    let Some(hwnd) = hwnd_from_main_window(app_handle) else {
        return;
    };
    let hwnd_val = hwnd as usize;
    let _ = app_handle.run_on_main_thread(move || {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            HWND_NOTOPMOST, SW_SHOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetForegroundWindow,
            SetWindowPos, ShowWindow,
        };
        let hwnd = hwnd_val as windows_sys::Win32::Foundation::HWND;
        unsafe {
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
            if SetWindowPos(
                hwnd,
                HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            ) == 0
            {
                eprintln!(
                    "[water-reminder] restore_window_from_tray: SetWindowPos(NOTOPMOST) failed"
                );
            }
        }
    });
}

/// Minimize the main window to the taskbar, or hide to the tray when enabled.
pub(crate) fn minimize_window(app_handle: &AppHandle) {
    let Some(hwnd) = hwnd_from_main_window(app_handle) else {
        eprintln!("[water-reminder] minimize_window: hwnd_from_main_window returned None");
        return;
    };
    let hwnd_val = hwnd as usize;
    let use_tray = MINIMIZE_TO_TRAY.load(Ordering::Relaxed);
    if let Err(e) = app_handle.run_on_main_thread(move || {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            IsWindowVisible, SW_HIDE, SW_MINIMIZE, SW_SHOWNORMAL, ShowWindow,
        };
        let hwnd = hwnd_val as windows_sys::Win32::Foundation::HWND;
        unsafe {
            if use_tray {
                ShowWindow(hwnd, SW_HIDE);
            } else {
                if IsWindowVisible(hwnd) == 0 {
                    ShowWindow(hwnd, SW_SHOWNORMAL);
                }
                ShowWindow(hwnd, SW_MINIMIZE);
            }
        }
    }) {
        eprintln!("[water-reminder] minimize_window: run_on_main_thread failed: {e}");
    }
}

// ── Taskbar flash ─────────────────────────────────────────────────────────────

/// Start flashing the taskbar button using `FlashWindowEx` directly,
/// bypassing tao's `request_user_attention` which skips the call when
/// the window is the currently active window.
pub(crate) fn flash_window_taskbar(app_handle: &AppHandle) {
    use windows_sys::Win32::{
        Foundation::{GetLastError, SetLastError},
        UI::WindowsAndMessaging::{FLASHW_ALL, FLASHW_TIMERNOFG, FLASHWINFO, FlashWindowEx},
    };

    let Some(hwnd) = hwnd_from_main_window(app_handle) else {
        return;
    };

    unsafe {
        let flash_info = FLASHWINFO {
            cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
            hwnd,
            dwFlags: FLASHW_ALL | FLASHW_TIMERNOFG,
            uCount: 0,
            dwTimeout: 0,
        };
        SetLastError(0);
        FlashWindowEx(&flash_info);
        let err = GetLastError();
        if err != 0 {
            eprintln!(
                "[water-reminder] FlashWindowEx failed to start taskbar flash (error {err})."
            );
        }
    }
}

/// Stop any taskbar flash unconditionally.
pub(crate) fn stop_window_attention(app_handle: &AppHandle) {
    use windows_sys::Win32::{
        Foundation::{GetLastError, SetLastError},
        UI::WindowsAndMessaging::{FLASHW_STOP, FLASHWINFO, FlashWindowEx},
    };

    let Some(hwnd) = hwnd_from_main_window(app_handle) else {
        return;
    };

    unsafe {
        let flash_info = FLASHWINFO {
            cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
            hwnd,
            dwFlags: FLASHW_STOP,
            uCount: 0,
            dwTimeout: 0,
        };
        SetLastError(0);
        FlashWindowEx(&flash_info);
        let err = GetLastError();
        if err != 0 {
            eprintln!(
                "[water-reminder] FlashWindowEx failed to stop taskbar flash (error {err})."
            );
        }
    }
}

// ── Wake lock ─────────────────────────────────────────────────────────────────

/// Ask the OS not to sleep while a reminder session is active.
/// Runs on the main thread so acquire and release are always on the same thread.
pub(crate) fn activate_wake_lock(app_handle: &AppHandle) {
    if let Err(e) = app_handle.run_on_main_thread(|| {
        use windows_sys::Win32::System::Power::{
            ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
        };
        unsafe {
            let result = SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
            if result == 0 {
                eprintln!(
                    "[water-reminder] SetThreadExecutionState (activate) failed: returned 0."
                );
            }
        }
    }) {
        eprintln!("[water-reminder] activate_wake_lock: run_on_main_thread failed: {e}");
    }
}

/// Release the wake lock previously acquired by `activate_wake_lock`.
pub(crate) fn deactivate_wake_lock(app_handle: &AppHandle) {
    if let Err(e) = app_handle.run_on_main_thread(|| {
        use windows_sys::Win32::System::Power::{ES_CONTINUOUS, SetThreadExecutionState};
        unsafe {
            let result = SetThreadExecutionState(ES_CONTINUOUS);
            if result == 0 {
                eprintln!(
                    "[water-reminder] SetThreadExecutionState (deactivate) failed: returned 0."
                );
            }
        }
    }) {
        eprintln!("[water-reminder] deactivate_wake_lock: run_on_main_thread failed: {e}");
    }
}
