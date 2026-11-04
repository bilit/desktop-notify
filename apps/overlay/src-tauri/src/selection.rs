//! Gets the text the user has selected in whatever app is in the foreground, without them copying first.
//!
//! A global hotkey only says "the key was pressed", so the only general way to read a selection is to make the
//! focused app copy it: simulate Ctrl+C, read the clipboard, then put the previous clipboard text back.
//! That is intrusive, so it is deliberately cautious:
//!
//!  * It never injects Ctrl+C into terminals or editors that run terminals (Ctrl+C there can interrupt a running
//!    process). For those apps, and for any app it can't identify, it falls back to the plain clipboard instead.
//!  * It waits for the user to release the hotkey's modifiers first; otherwise the app would see Ctrl+Shift+C
//!    (e.g. "inspect element" in a browser) instead of Ctrl+C.
//!  * It only trusts the result if the clipboard actually changed (checked via the clipboard sequence number). If
//!    nothing was selected, or the app is elevated and Windows blocked the injected keys, it returns None rather
//!    than sending whatever stale text was on the clipboard.
//!  * Clipboard contents are never logged.
//!
//! Limits: only text is restored (an image or file list on the clipboard is replaced by the selection), and apps
//! that ignore synthetic Ctrl+C simply yield None.

use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// The current clipboard text, trimmed; None if empty or not text.
pub fn read_clipboard(app: &AppHandle) -> Option<String> {
    app.clipboard()
        .read_text()
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

#[cfg(windows)]
pub use win::{beep, grab};

#[cfg(not(windows))]
pub fn grab(app: &AppHandle) -> Option<String> {
    read_clipboard(app) // no selection capture off Windows: copy first, then press the hotkey
}

#[cfg(not(windows))]
pub fn beep() {}

#[cfg(windows)]
mod win {
    use std::collections::HashSet;
    use std::mem::size_of;
    use std::sync::OnceLock;
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    use tauri::AppHandle;
    use tauri_plugin_clipboard_manager::ClipboardExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL,
        VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::MessageBeep;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, MB_ICONEXCLAMATION,
    };

    use super::read_clipboard;

    const VK_C: u16 = 0x43;

    /// Apps where a synthetic Ctrl+C is unsafe (it can send an interrupt). Extend with the
    /// OVERLAY_NO_AUTOCOPY environment variable (comma-separated exe names).
    const NEVER_INJECT: &[&str] = &[
        "windowsterminal.exe", "wt.exe", "openconsole.exe", "conhost.exe", "cmd.exe", "powershell.exe",
        "pwsh.exe", "bash.exe", "wsl.exe", "mintty.exe", "wezterm-gui.exe", "alacritty.exe", "putty.exe",
        "kitty.exe", "tabby.exe", "hyper.exe",
        // Editors with an integrated terminal: we can't tell whether the terminal or the editor has focus.
        "code.exe", "code - insiders.exe", "cursor.exe",
    ];

    fn denylist() -> &'static HashSet<String> {
        static LIST: OnceLock<HashSet<String>> = OnceLock::new();
        LIST.get_or_init(|| {
            let mut set: HashSet<String> = NEVER_INJECT.iter().map(|s| s.to_string()).collect();
            if let Ok(extra) = std::env::var("OVERLAY_NO_AUTOCOPY") {
                set.extend(extra.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()));
            }
            set
        })
    }

    /// Lower-cased exe file name of the foreground window's process, or None if it can't be determined
    /// (which includes elevated processes we aren't allowed to inspect).
    fn foreground_exe() -> Option<String> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 {
                return None;
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut buf = [0u16; 520];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(process);
            if ok == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit('\\').next().map(|n| n.to_lowercase())
        }
    }

    fn key_down(vk: u16) -> bool {
        unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 }
    }

    /// True once Ctrl, Shift, Alt and Win are all up, i.e. the user let go of the hotkey.
    fn wait_for_modifier_release(max: Duration) -> bool {
        let deadline = Instant::now() + max;
        while [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN].into_iter().any(key_down) {
            if Instant::now() > deadline {
                return false;
            }
            sleep(Duration::from_millis(10));
        }
        true
    }

    fn key_event(vk: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// Sends Ctrl+C to the foreground window. Returns false if Windows refused the input.
    fn send_ctrl_c() -> bool {
        let inputs = [
            key_event(VK_CONTROL, false),
            key_event(VK_C, false),
            key_event(VK_C, true),
            key_event(VK_CONTROL, true),
        ];
        let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32) };
        sent as usize == inputs.len()
    }

    /// The selected text in the foreground app, or None if nothing could be captured.
    /// For apps we must not inject into, this is the current clipboard instead (copy first, then hotkey).
    pub fn grab(app: &AppHandle) -> Option<String> {
        let skip = match foreground_exe() {
            None => true, // unknown or elevated: don't guess
            Some(exe) => denylist().contains(&exe),
        };
        if skip {
            return read_clipboard(app);
        }

        if !wait_for_modifier_release(Duration::from_millis(1500)) {
            return None;
        }

        let previous = app.clipboard().read_text().ok();
        let before = unsafe { GetClipboardSequenceNumber() };
        if !send_ctrl_c() {
            return None;
        }

        // No change in the sequence number means nothing was copied: no selection, or input was blocked.
        let deadline = Instant::now() + Duration::from_millis(600);
        while unsafe { GetClipboardSequenceNumber() } == before {
            if Instant::now() > deadline {
                return None;
            }
            sleep(Duration::from_millis(15));
        }

        // Some apps bump the sequence number slightly before the text is readable.
        let mut text = None;
        for _ in 0..5 {
            if let Some(t) = read_clipboard(app) {
                text = Some(t);
                break;
            }
            sleep(Duration::from_millis(20));
        }

        if let Some(previous) = previous {
            let _ = app.clipboard().write_text(previous); // put the user's clipboard back
        }
        text
    }

    /// Audible "nothing was sent" signal; the overlay has no window to show an error in.
    pub fn beep() {
        unsafe { MessageBeep(MB_ICONEXCLAMATION) };
    }
}
