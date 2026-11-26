mod legacy;
mod share;

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{AboutMetadata, Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const STATE_FILE: &str = "state.json";
const BACKUP_FILE: &str = "state.json.bak";
const SNAPSHOT_DIR: &str = "snapshots";
const SNAPSHOTS_TO_KEEP: usize = 14;
const MAX_IMPORT_BYTES: u64 = 25 * 1024 * 1024;
const IMPORT_EXTENSIONS: &[&str] = &["txt", "zip", "json", "thub"];

/// Serialises every read/write of the state file so overlapping saves can never interleave.
struct StoreLock(Mutex<()>);

#[derive(Serialize)]
struct PickedFile {
    name: String,
    bytes: Vec<u8>,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// Write to a temp file, flush to disk, then rename over the target so a crash
/// mid-write can never leave a half-written state file behind.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(err)?;
        f.write_all(bytes).map_err(err)?;
        f.sync_all().map_err(err)?;
    }
    fs::rename(&tmp, path).map_err(err)
}

#[tauri::command]
fn load_state(app: AppHandle, lock: State<StoreLock>) -> Result<Option<String>, String> {
    let _guard = lock.0.lock().map_err(err)?;
    let dir = data_dir(&app)?;
    // Fall back to the previous good copy if the main file is unreadable or corrupt.
    for name in [STATE_FILE, BACKUP_FILE] {
        if let Ok(text) = fs::read_to_string(dir.join(name)) {
            if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
                return Ok(Some(text));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
fn save_state(app: AppHandle, lock: State<StoreLock>, json: String, day: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("Refusing to save invalid state: {e}"))?;
    let _guard = lock.0.lock().map_err(err)?;
    let dir = data_dir(&app)?;
    let main = dir.join(STATE_FILE);

    if main.exists() {
        let _ = fs::copy(&main, dir.join(BACKUP_FILE));
    }
    atomic_write(&main, json.as_bytes())?;

    // One snapshot per calendar day (first save of the day), pruned to the most recent N.
    let day_ok = day.len() == 10 && day.chars().all(|c| c.is_ascii_digit() || c == '-');
    if day_ok {
        let snap_dir = dir.join(SNAPSHOT_DIR);
        if fs::create_dir_all(&snap_dir).is_ok() {
            let snap = snap_dir.join(format!("state-{day}.json"));
            if !snap.exists() {
                let _ = fs::write(&snap, json.as_bytes());
                if let Ok(entries) = fs::read_dir(&snap_dir) {
                    let mut names: Vec<PathBuf> = entries
                        .filter_map(|e| e.ok().map(|e| e.path()))
                        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
                        .collect();
                    names.sort();
                    while names.len() > SNAPSHOTS_TO_KEEP {
                        let _ = fs::remove_file(names.remove(0));
                    }
                }
            }
        }
    }
    Ok(())
}

/// Shows a native save dialog and writes `contents` to the chosen path.
/// Returns the saved path, or None if the user cancelled.
#[tauri::command]
async fn save_file(
    window: WebviewWindow,
    default_name: String,
    contents: Vec<u8>,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<String>, String> {
    let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let picked = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(default_name)
        .add_filter(filter_name, &exts)
        .blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(err)?;
    fs::write(&path, contents).map_err(err)?;
    Ok(Some(path.display().to_string()))
}

fn read_import_file(path: &Path) -> Result<PickedFile, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !IMPORT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "Unsupported file type \".{ext}\". Use a .txt backup or a .zip history archive."
        ));
    }
    let meta = fs::metadata(path).map_err(err)?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err("That file is too large to be a tournament backup.".into());
    }
    Ok(PickedFile {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        bytes: fs::read(path).map_err(err)?,
    })
}

/// Shows a native open dialog and returns the contents of every chosen file.
#[tauri::command]
async fn open_import_files(window: WebviewWindow) -> Result<Vec<PickedFile>, String> {
    let picked = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Import tournament backups")
        .add_filter("Tournament backups", IMPORT_EXTENSIONS)
        .blocking_pick_files();
    let Some(paths) = picked else { return Ok(vec![]) };
    paths
        .into_iter()
        .map(|p| read_import_file(&p.into_path().map_err(err)?))
        .collect()
}

/// Reads a file the user dragged onto the window.
#[tauri::command]
async fn read_dropped_file(path: String) -> Result<PickedFile, String> {
    read_import_file(Path::new(&path))
}

/// Finds data left behind by the old Electron build of Bracket Maker.
#[tauri::command]
async fn find_legacy_data(app: AppHandle) -> Result<Vec<legacy::LegacyProfile>, String> {
    let root = app.path().config_dir().map_err(err)?;
    Ok(legacy::scan(&root))
}

#[tauri::command]
fn share_start(share: State<share::ShareState>, port: u16) -> Result<share::ShareInfo, String> {
    share.start(port)
}

#[tauri::command]
fn share_stop(share: State<share::ShareState>) {
    share.stop();
}

#[tauri::command]
fn share_status(share: State<share::ShareState>) -> share::ShareInfo {
    share.status()
}

/// The page pushes the tournament it is showing (or `null`) after every change.
#[tauri::command]
fn share_update(share: State<share::ShareState>, payload: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&payload).map_err(|e| format!("Invalid payload: {e}"))?;
    share.update(payload);
    Ok(())
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only web links can be opened.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

#[tauri::command]
fn reveal_data_folder(app: AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)?;
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(err)
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accel: &str| {
        let b = MenuItemBuilder::with_id(id, text);
        if accel.is_empty() { b.build(app) } else { b.accelerator(accel).build(app) }
    };

    let settings = item("settings", "Settings…", "CmdOrCtrl+,")?;

    let mut file = SubmenuBuilder::new(app, "File")
        .item(&item("new_tournament", "New Tournament…", "CmdOrCtrl+N")?)
        .separator()
        .item(&item("import", "Import Backup…", "CmdOrCtrl+O")?)
        .item(&item("export", "Export Backup…", "CmdOrCtrl+E")?)
        .item(&item("export_results", "Export Results…", "CmdOrCtrl+Shift+E")?)
        .separator()
        .item(&item("print", "Print Bracket…", "CmdOrCtrl+P")?);
    if cfg!(not(target_os = "macos")) {
        file = file.separator().item(&settings).separator().quit();
    } else {
        file = file.separator().close_window();
    }

    // Undo/redo are custom so they can drive tournament history; the page forwards
    // them to the focused text field when one is active.
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item("undo", "Undo", "CmdOrCtrl+Z")?)
        .item(&item("redo", "Redo", "CmdOrCtrl+Shift+Z")?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("find", "Find Player", "CmdOrCtrl+F")?);

    let mut view = SubmenuBuilder::new(app, "View")
        .item(&item("bracket_map", "Bracket Map", "CmdOrCtrl+B")?)
        .separator()
        .item(&item("theme_system", "Appearance: System", "")?)
        .item(&item("theme_light", "Appearance: Light", "")?)
        .item(&item("theme_dark", "Appearance: Dark", "")?)
        .item(&item("toggle_theme", "Toggle Light/Dark", "CmdOrCtrl+Shift+L")?);
    if cfg!(target_os = "macos") {
        view = view.separator().fullscreen();
    }

    let go = SubmenuBuilder::new(app, "Go")
        .item(&item("go_home", "Home", "CmdOrCtrl+1")?)
        .item(&item("go_active", "Current Tournament", "CmdOrCtrl+2")?)
        .item(&item("go_history", "Tournament History", "CmdOrCtrl+3")?)
        .item(&item("go_data", "Import & Export", "CmdOrCtrl+4")?)
        .separator()
        .item(&item("live_share", "Live Website…", "CmdOrCtrl+L")?);

    let menu = Menu::new(app)?;
    if cfg!(target_os = "macos") {
        let app_menu = SubmenuBuilder::new(app, "Bracket Maker")
            .about(Some(AboutMetadata {
                name: Some("Bracket Maker".into()),
                version: Some(app.package_info().version.to_string()),
                comments: Some("Round Robin, Swiss, Single & Double Elimination tournaments.".into()),
                ..Default::default()
            }))
            .separator()
            .item(&settings)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu.append(&app_menu)?;
    }
    menu.append(&file.build()?)?;
    menu.append(&edit.build()?)?;
    menu.append(&view.build()?)?;
    menu.append(&go.build()?)?;
    if cfg!(target_os = "macos") {
        let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;
        menu.append(&window)?;
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(StoreLock(Mutex::new(())))
        .manage(share::ShareState::new())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let _ = app.emit_to("main", "menu", event.id().0.clone());
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_state,
            save_file,
            open_import_files,
            read_dropped_file,
            find_legacy_data,
            reveal_data_folder,
            share_start,
            share_stop,
            share_status,
            share_update,
            open_external
        ])
        .build(tauri::generate_context!())
        .expect("error while building Bracket Maker")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<share::ShareState>().stop();
            }
        });
}
