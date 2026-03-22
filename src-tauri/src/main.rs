// main.rs – thin entry point that just calls into the library crate.
//
// The `windows_subsystem` attribute prevents an additional console window
// from appearing on Windows in release builds.  It must stay here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    water_reminder_lib::run();
}
