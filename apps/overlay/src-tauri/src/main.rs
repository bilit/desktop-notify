// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Rust here is only the native shell: one transparent always-on-top window, a tray icon, and window
// geometry. All networking and UI live in the webview (src/), which talks to the hub itself.
//
// The window has two modes, chosen by the UI:
//   cards  1-2 notifications: not resizable, sized to hug the content and centered (fit_overlay)
//   panel  3+ notifications: user-resizable and draggable; its geometry is reported so the UI can remember it

mod selection;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, State, Url, UserAttentionType,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

/// Global hotkey (works in any app): sends the text you have selected (no Ctrl+C needed) to the hub, which shows it
/// in the browser. Ctrl+J alone is taken by many apps (browser downloads, editors), so the default avoids it.
/// Override with the OVERLAY_HOTKEY environment variable, e.g. "ctrl+alt+j".
/// Set OVERLAY_HOTKEY_MODE=clipboard to send the current clipboard instead of capturing the selection.
const DEFAULT_HOTKEY: &str = "ctrl+shift+j";

/// True while a capture is running, so key-repeat or a double press can't start a second one.
static CAPTURING: AtomicBool = AtomicBool::new(false);

/// Captures text off the main thread (it waits for you to release the hotkey) and hands it to the webview,
/// which owns the hub connection. Nothing is sent, and the system beeps, if there was nothing to capture.
fn capture_and_send(app: tauri::AppHandle) {
    if CAPTURING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let clipboard_only = std::env::var("OVERLAY_HOTKEY_MODE").is_ok_and(|m| m.eq_ignore_ascii_case("clipboard"));
        let text = if clipboard_only { selection::read_clipboard(&app) } else { selection::grab(&app) };
        match text {
            Some(text) => {
                let _ = app.emit("clipboard-send", text);
            }
            None => selection::beep(),
        }
        CAPTURING.store(false, Ordering::SeqCst);
    });
}

const DEFAULT_PANEL: (f64, f64) = (420.0, 560.0);
const MIN_PANEL: (f64, f64) = (360.0, 240.0);

/// True while the window is in panel mode. Geometry events are only reported then.
struct PanelMode(Mutex<bool>);

/// Logical (DPI-independent) window rectangle, saved by the UI between runs.
#[derive(Serialize, Deserialize, Clone, Copy)]
struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}

fn show_if_hidden(window: &WebviewWindow) -> Result<(), String> {
    if !window.is_visible().map_err(err)? {
        window.show().map_err(err)?;
    }
    Ok(())
}

/// Centers a window of the given logical size on the primary monitor.
fn center_on_primary(window: &WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    if let Some(m) = window.primary_monitor().map_err(err)? {
        let scale = m.scale_factor();
        let (mx, my) = (m.position().x as f64, m.position().y as f64);
        let (mw, mh) = (m.size().width as f64, m.size().height as f64);
        let x = mx + (mw - width * scale) / 2.0;
        let y = my + (mh - height * scale) / 2.0;
        window
            .set_position(PhysicalPosition::new(x as i32, y.max(my + 10.0) as i32))
            .map_err(err)?;
    }
    Ok(())
}

/// A saved position is only trusted if its top-left area is still on some monitor
/// (a monitor may have been unplugged since it was saved).
fn on_screen(window: &WebviewWindow, g: &Geometry) -> bool {
    let Ok(monitors) = window.available_monitors() else { return false };
    let Ok(scale) = window.scale_factor() else { return false };
    let (px, py) = ((g.x + 40.0) * scale, (g.y + 20.0) * scale);
    monitors.iter().any(|m| {
        let (mx, my) = (m.position().x as f64, m.position().y as f64);
        let (mw, mh) = (m.size().width as f64, m.size().height as f64);
        px >= mx && px < mx + mw && py >= my && py < my + mh
    })
}

/// Identifies the most recent raise, so an older hold timer can't release a newer hold early.
static HOLD_GEN: AtomicU64 = AtomicU64::new(0);

/// Brings the window above every other window, but does NOT leave it always-on-top.
///
/// It asserts topmost, keeps it for `hold_ms` (so clicking another app right after an arrival can't bury an
/// urgent notification), then releases it: the window stays at the front of the normal stack and any later click
/// elsewhere covers it. `hold_ms == 0` asserts and releases at once, which still jumps to the front.
/// Neither step activates the window or takes keyboard focus.
fn raise(window: &WebviewWindow, hold_ms: u64) -> Result<(), String> {
    if !window.is_visible().map_err(err)? {
        return Ok(()); // nothing live: don't resurrect an empty overlay
    }
    let generation = HOLD_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    window.set_always_on_top(true).map_err(err)?;

    if hold_ms == 0 {
        return window.set_always_on_top(false).map_err(err);
    }
    let w = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(hold_ms));
        // Only release if nothing raised the window again in the meantime; that later raise owns the release.
        if HOLD_GEN.load(Ordering::SeqCst) == generation {
            let _ = w.set_always_on_top(false);
        }
    });
    Ok(())
}

/// Called by the UI when a NEW notification arrives (not for updates or resolutions).
#[tauri::command]
fn raise_overlay(window: WebviewWindow, hold_ms: Option<u64>) -> Result<(), String> {
    raise(&window, hold_ms.unwrap_or(0))?;
    // Once another app covers the cards there must still be a way to find them, so give the window a taskbar button and
    // flash it. The flash does not take focus or interrupt typing; it stops when the user clicks the button or a card.
    window.set_skip_taskbar(false).map_err(err)?;
    window
        .request_user_attention(Some(UserAttentionType::Informational))
        .map_err(err)
}

/// The overlay has a taskbar button only while something is showing; with nothing live it stays out of the taskbar
/// (and any pending flash is cancelled).
#[tauri::command]
fn set_taskbar(window: WebviewWindow, show: bool) -> Result<(), String> {
    window.set_skip_taskbar(!show).map_err(err)?;
    if !show {
        window.request_user_attention(None).map_err(err)?;
    }
    Ok(())
}

/// The tray icon plus the tooltip it shows when nothing is waiting. The base text can carry a warning (for example that
/// the hotkey was unavailable), which the live count must not overwrite.
struct TrayInfo {
    tray: tauri::tray::TrayIcon,
    base: Mutex<String>,
}

/// Tray tooltip text. Windows cuts tooltips at 127 characters, so stay under that.
fn tray_tooltip(base: &str, live: usize, hidden: usize) -> String {
    let text = match (live, hidden) {
        (0, _) => base.to_string(),
        (n, 0) => format!("{base}: {n} waiting"),
        (n, h) => format!("{base}: {n} waiting ({h} hidden, click to show)"),
    };
    text.chars().take(127).collect()
}

/// Keeps the tray tooltip in step with what is live, so the count is visible without opening anything.
#[tauri::command]
fn set_tray_status(state: State<TrayInfo>, live: usize, hidden: usize) -> Result<(), String> {
    let base = state.base.lock().unwrap().clone();
    state.tray.set_tooltip(Some(tray_tooltip(&base, live, hidden))).map_err(err)
}

/// Cards mode: the webview calls this after every layout change so the window hugs its content.
/// A transparent window larger than its content would swallow clicks meant for other apps.
#[tauri::command]
fn fit_overlay(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    if height < 1.0 {
        if window.is_visible().map_err(err)? {
            window.hide().map_err(err)?;
        }
        return Ok(());
    }
    window.set_size(LogicalSize::new(width, height)).map_err(err)?;
    center_on_primary(&window, width, height)?;
    show_if_hidden(&window)
}

/// Switches between cards and panel mode. `geometry` is the panel's last saved rectangle, if any.
#[tauri::command]
fn set_panel_mode(
    window: WebviewWindow,
    state: State<PanelMode>,
    active: bool,
    geometry: Option<Geometry>,
) -> Result<(), String> {
    *state.0.lock().unwrap() = active;

    if !active {
        // Leave size alone: fit_overlay (or hiding, when nothing is left) handles the next layout.
        window.set_min_size(None::<LogicalSize<f64>>).map_err(err)?;
        window.set_resizable(false).map_err(err)?;
        return Ok(());
    }

    window.set_resizable(true).map_err(err)?;
    window
        .set_min_size(Some(LogicalSize::new(MIN_PANEL.0, MIN_PANEL.1)))
        .map_err(err)?;

    match geometry.filter(|g| g.width >= MIN_PANEL.0 && g.height >= MIN_PANEL.1 && on_screen(&window, g)) {
        Some(g) => {
            window.set_size(LogicalSize::new(g.width, g.height)).map_err(err)?;
            window.set_position(LogicalPosition::new(g.x, g.y)).map_err(err)?;
        }
        None => {
            window.set_size(LogicalSize::new(DEFAULT_PANEL.0, DEFAULT_PANEL.1)).map_err(err)?;
            center_on_primary(&window, DEFAULT_PANEL.0, DEFAULT_PANEL.1)?;
        }
    }
    show_if_hidden(&window)
}

// ---------------------------------------------------------------------------------------------------------------------
// Optional app window
//
// With NOTIFY_APP_URL set, the overlay also hosts your web app in a normal window (created hidden, shown from the
// tray or when a notification is clicked). That window loads a REMOTE page, and the capability file only names the
// "overlay" window, so the page can call NO native commands. The only thing that reaches it is a one-way push from
// here: a plain browser event, `window.dispatchEvent(new CustomEvent('notify-open', { detail }))`.
// ---------------------------------------------------------------------------------------------------------------------

const APP_LABEL: &str = "app";

/// Only plain web addresses may be hosted: no file:, javascript:, data: and so on.
fn parse_app_url(raw: &str) -> Option<Url> {
    let url: Url = raw.trim().parse().ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

/// The script that delivers a clicked notification to the page.
///
/// The page may not have registered its listener yet (still loading, or mid-login redirect), so the detail is also
/// parked on `window.__notifyOpenPending` for the page to pick up when it mounts (`useHub`'s `onOpen` does both).
/// Only `id`, `kind`, `data` and `open` are forwarded, and the JSON is escaped by serde, so notification content
/// can't break out of the string.
fn dispatch_script(notification: &serde_json::Value) -> Option<String> {
    let id = notification.get("id")?.as_str().filter(|s| !s.is_empty() && s.len() <= 200)?;
    let field = |name: &str| notification.get(name).cloned().unwrap_or(serde_json::Value::Null);
    let detail = serde_json::json!({
        "id": id,
        "kind": notification.get("kind").and_then(|k| k.as_str()).unwrap_or(""),
        "data": field("data"),
        "open": field("open"),
    });
    let json = serde_json::to_string(&detail).ok()?;
    Some(format!(
        "(function(d){{window.__notifyOpenPending=d;window.dispatchEvent(new CustomEvent('notify-open',{{detail:d}}));}})({json});"
    ))
}

/// Shows and focuses the app window. The user has just clicked in this process, which is what lets Windows
/// allow it to take the foreground.
fn show_app(app: &AppHandle) -> Result<WebviewWindow, String> {
    let w = app
        .get_webview_window(APP_LABEL)
        .ok_or("no app window: set NOTIFY_APP_URL to your web app's address")?;
    if w.is_minimized().unwrap_or(false) {
        let _ = w.unminimize();
    }
    w.show().map_err(err)?;
    w.set_focus().map_err(err)?;
    Ok(w)
}

/// A card was clicked: bring the app window forward and tell the page which notification it was.
#[tauri::command]
fn open_in_app(app: AppHandle, notification: serde_json::Value) -> Result<(), String> {
    let script = dispatch_script(&notification).ok_or("notification has no usable id")?;
    let w = show_app(&app)?;
    w.eval(&script).map_err(err)
}

/// The name the overlay announces to the notify server so it knows whose notifications to send: `NOTIFY_USER` if set,
/// otherwise the Windows user name. This is a CLAIM, not a login: nothing proves it. Whether the server believes it is
/// the integrator's decision (`authenticateDesktop`); real sign-in (SSO) replaces this later.
fn identity_from(notify_user: Option<String>, os_user: Option<String>) -> Option<String> {
    notify_user
        .into_iter()
        .chain(os_user)
        .map(|s| s.trim().to_string())
        .find(|s| !s.is_empty() && s.len() <= 128)
}

#[tauri::command]
fn overlay_identity() -> Option<String> {
    identity_from(std::env::var("NOTIFY_USER").ok(), std::env::var("USERNAME").ok())
}

/// Lets the UI show a "click to open" affordance only when there is an app window to open.
#[tauri::command]
fn app_configured(app: AppHandle) -> bool {
    app.get_webview_window(APP_LABEL).is_some()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PanelMode(Mutex::new(false)))
        .invoke_handler(tauri::generate_handler![
            fit_overlay,
            set_panel_mode,
            raise_overlay,
            set_taskbar,
            set_tray_status,
            open_in_app,
            app_configured,
            overlay_identity
        ])
        .on_window_event(|window, event| {
            // The app window hides instead of closing, so the overlay (and its tray icon) keeps running.
            if window.label() == APP_LABEL {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
                return;
            }
            // In panel mode, report every move/resize so the UI can remember where the user put it.
            if !matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_)) {
                return;
            }
            let in_panel = *window.app_handle().state::<PanelMode>().0.lock().unwrap();
            if !in_panel {
                return;
            }
            let (Ok(scale), Ok(size), Ok(pos)) = (window.scale_factor(), window.inner_size(), window.outer_position())
            else {
                return;
            };
            let (size, pos) = (size.to_logical::<f64>(scale), pos.to_logical::<f64>(scale));
            let _ = window.emit(
                "overlay-geometry",
                Geometry { x: pos.x, y: pos.y, width: size.width, height: size.height },
            );
        })
        .setup(|app| {
            // Optional: host your web app in a window. Created hidden, so its login/redirects can run in the
            // background; "Open app" in the tray (or clicking a card) shows it.
            let app_window = match std::env::var("NOTIFY_APP_URL") {
                Ok(raw) => match parse_app_url(&raw) {
                    Some(url) => {
                        WebviewWindowBuilder::new(app, APP_LABEL, WebviewUrl::External(url))
                            .title("Notify App")
                            .inner_size(1280.0, 800.0)
                            .visible(false)
                            .build()?;
                        true
                    }
                    None => {
                        eprintln!("NOTIFY_APP_URL must be an http(s) address; ignoring '{raw}'");
                        false
                    }
                },
                Err(_) => false,
            };

            let quit = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;
            let menu = Menu::new(app)?;
            if app_window {
                menu.append(&MenuItem::with_id(app, "open_app", "Open app", true, None::<&str>)?)?;
                menu.append(&PredefinedMenuItem::separator(app)?)?;
            }
            menu.append(&quit)?;

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Notify Overlay")
                .menu(&menu)
                // The overlay has no taskbar button and can be buried under other windows, so a
                // left-click on the tray icon is the way to bring it back to the front.
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        // Also bring back anything the user closed (×) on the overlay: the UI owns that list.
                        let _ = tray.app_handle().emit("tray-action", "unhide");
                        if let Some(w) = tray.app_handle().get_webview_window("overlay") {
                            let _ = raise(&w, 0); // the user asked for it, so no hold
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open_app" => { let _ = show_app(app); }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Global hotkey: capture the selected text and hand it to the webview, which owns the hub connection.
            // Only runs on an explicit keypress; the clipboard is never polled and its contents are never logged.
            let hotkey = std::env::var("OVERLAY_HOTKEY").unwrap_or_else(|_| DEFAULT_HOTKEY.to_string());
            let registered = app.global_shortcut().on_shortcut(hotkey.as_str(), |app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    capture_and_send(app.clone());
                }
            });
            let mut base = "Notify Overlay".to_string();
            if let Err(e) = registered {
                // Another app already owns this combination (or it didn't parse). Say so instead of failing silently.
                eprintln!("could not register hotkey '{hotkey}': {e}");
                base = format!("Notify Overlay (hotkey {hotkey} unavailable)");
                let _ = tray.set_tooltip(Some(base.clone()));
            }
            // The UI updates the tooltip with a live count; it needs the tray handle and this warning to build the text.
            app.manage(TrayInfo { tray, base: Mutex::new(base) });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hosts_only_plain_web_addresses() {
        assert!(parse_app_url("https://app.example.com/orders").is_some());
        assert!(parse_app_url("  http://localhost:5173  ").is_some());
        for bad in ["file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://x.test", "not a url", ""] {
            assert!(parse_app_url(bad).is_none(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn push_script_carries_only_the_known_fields() {
        let script = dispatch_script(&json!({
            "id": "job-1001", "kind": "job", "data": {"label": "alpha"}, "open": {"path": "/jobs/7"},
            "secret": "must not be forwarded", "createdAt": 1
        }))
        .unwrap();
        assert!(script.contains("notify-open"));
        assert!(script.contains("__notifyOpenPending"));
        assert!(script.contains(r#""id":"job-1001""#));
        assert!(script.contains(r#""path":"/jobs/7""#));
        assert!(!script.contains("must not be forwarded"));
        assert!(!script.contains("createdAt"));
    }

    #[test]
    fn notification_content_cannot_break_out_of_the_script() {
        // A hostile title tries to close the JSON string and run its own code.
        let hostile = r#"x"});alert(document.cookie);//"#;
        let script = dispatch_script(&json!({ "id": "a", "kind": "k", "data": { "title": hostile } })).unwrap();
        assert!(script.contains(r#"x\"});alert(document.cookie);//"#), "quote must be escaped: {script}");
        assert!(!script.contains(r#"":"x"});"#), "unescaped break-out present: {script}");
    }

    #[test]
    fn tray_tooltip_shows_the_count_and_keeps_the_base_warning() {
        assert_eq!(tray_tooltip("Notify Overlay", 0, 0), "Notify Overlay");
        assert_eq!(tray_tooltip("Notify Overlay", 0, 3), "Notify Overlay", "nothing live: no count, even if ids linger");
        assert_eq!(tray_tooltip("Notify Overlay", 3, 0), "Notify Overlay: 3 waiting");
        assert_eq!(tray_tooltip("Notify Overlay", 3, 2), "Notify Overlay: 3 waiting (2 hidden, click to show)");
        // the hotkey warning is part of the base and must survive
        let warn = "Notify Overlay (hotkey ctrl+shift+j unavailable)";
        assert!(tray_tooltip(warn, 1, 0).starts_with(warn));
        // Windows truncates tooltips at 127 characters; never hand it more
        assert_eq!(tray_tooltip(&"x".repeat(300), 5, 1).chars().count(), 127);
    }

    #[test]
    fn identity_prefers_notify_user_then_the_os_user() {
        let s = |v: &str| Some(v.to_string());
        assert_eq!(identity_from(s("alice"), s("WinUser")), s("alice"));
        assert_eq!(identity_from(None, s("WinUser")), s("WinUser"));
        assert_eq!(identity_from(s("  "), s("WinUser")), s("WinUser"), "blank NOTIFY_USER falls through");
        assert_eq!(identity_from(s(" alice "), None), s("alice"), "trimmed");
        assert_eq!(identity_from(None, None), None);
        assert_eq!(identity_from(s(&"x".repeat(129)), s("WinUser")), s("WinUser"), "over-long names are skipped");
    }

    #[test]
    fn push_needs_a_usable_id() {
        assert!(dispatch_script(&json!({ "kind": "k" })).is_none());
        assert!(dispatch_script(&json!({ "id": "" })).is_none());
        assert!(dispatch_script(&json!({ "id": 5 })).is_none());
        assert!(dispatch_script(&json!({ "id": "x".repeat(201) })).is_none());
        assert!(dispatch_script(&json!({ "id": "x".repeat(200) })).is_some());
    }
}
