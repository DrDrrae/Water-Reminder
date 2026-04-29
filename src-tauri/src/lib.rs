// lib.rs — application entry point.
//
// All logic has been moved to focused sub-modules:
//
//   state    — shared types (ReminderConfig, AppState, StateSnapshot), validation,
//              and the interval_duration() helper.
//   store    — settings persistence (load_config / persist_config).
//   timer    — background timer thread + desktop notification.
//   commands — all #[tauri::command] functions exposed to the frontend.
//   platform — platform-agnostic wrappers around OS-specific behaviour.
//              platform::windows — all Win32 / COM code (Windows-only).
//
// This file only declares the modules, creates the shared state, builds the
// tray icon, wires up plugins and commands, and runs the Tauri event loop.

pub mod commands;
pub mod platform;
pub mod state;
pub mod store;
pub mod timer;

use std::sync::{Arc, Mutex};

use tauri::Manager;

use commands::apply_saved_config;
use state::{AppState, SharedState};

// ── Application entry point ───────────────────────────────────────────────────

/// Called from `main.rs`.  Builds the Tauri application, registers plugins
/// and commands, loads any previously saved settings, optionally auto-starts
/// reminders, then runs the event loop.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(Arc::new(Mutex::new(AppState::new())) as SharedState)
        .setup(|app| {
            let shared_state = Arc::clone(&*app.state::<SharedState>());

            // Load saved config; detect auto-start parameters.
            let (auto_start_gen, auto_start_keep_awake, auto_start_minimize) =
                apply_saved_config(&shared_state, app.handle());

            // Determine whether the tray icon should start visible.
            let tray_visible = shared_state
                .lock()
                .map(|s| s.config.minimize_to_tray)
                .unwrap_or(false);

            // Install OS hooks and store globals (WndProc, session notifications).
            platform::setup(app.handle(), &shared_state);

            // Sync config-derived atomics with the loaded config.
            {
                let s = shared_state.lock().unwrap();
                platform::sync_minimize_to_tray_state(app.handle(), s.config.minimize_to_tray);
                platform::sync_pause_on_lock_state(s.config.pause_on_lock);
            }

            // Build the system tray icon and context menu (cross-platform).
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

                let show_item = MenuItem::with_id(
                    app,
                    "show",
                    "Show Water Reminder",
                    true,
                    None::<&str>,
                )?;
                let quit_item =
                    MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

                let tray_icon = app.default_window_icon().cloned().ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "default window icon not configured; cannot create tray icon",
                    )
                })?;

                TrayIconBuilder::with_id("main-tray")
                    .icon(tray_icon)
                    .menu(&menu)
                    .tooltip("Water Reminder")
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => platform::restore_window_from_tray(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            platform::restore_window_from_tray(tray.app_handle());
                        }
                    })
                    .build(app)?
                    .set_visible(tray_visible)?;
            }

            // Auto-start: spawn timer thread and optionally acquire wake lock.
            if let Some(my_gen) = auto_start_gen {
                timer::spawn_timer_thread(
                    Arc::clone(&shared_state),
                    app.handle().clone(),
                    my_gen,
                );
                if auto_start_keep_awake {
                    platform::activate_wake_lock(app.handle());
                }
            }

            // When auto-start + minimize-on-acknowledge are both enabled, start
            // with the window already minimized (or hidden to tray).
            if auto_start_minimize {
                platform::minimize_window(app.handle());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::save_config,
            commands::start_reminders,
            commands::stop_reminders,
            commands::pause_reminders,
            commands::resume_reminders,
            commands::reset_reminders,
            commands::reset_active_countdown,
            commands::snooze_reminder,
            commands::acknowledge_reminder,
            commands::get_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
