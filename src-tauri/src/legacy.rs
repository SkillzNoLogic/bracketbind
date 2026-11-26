//! Reads tournament data left behind by the old Electron build of Bracket Maker.
//!
//! Electron keeps `localStorage` in a Chromium LevelDB under
//! `<config dir>/<app name>/Local Storage/leveldb`. Keys look like
//! `_file://\0\x01<key>` and values are prefixed with an encoding byte
//! (`\x01` = Latin-1, `\x00` = UTF-16LE). We copy the database to a temp folder
//! first so the original is never locked or modified.

use rusty_leveldb::{LdbIterator, Options, DB};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Folder names the Electron app has shipped under (package name / product name).
const PROFILE_NAMES: &[&str] = &["test-app", "Bracket Maker", "bracket-maker", "Tournament Hub"];

const WANTED_KEYS: &[&str] = &[
    "tournament_history_v3",
    "tournament_hub_settings_v1",
    "active_tournament_id",
    "h_theme",
];

#[derive(Serialize)]
pub struct LegacyProfile {
    pub source: String,
    pub values: BTreeMap<String, String>,
}

pub fn scan(config_root: &Path) -> Vec<LegacyProfile> {
    PROFILE_NAMES
        .iter()
        .filter_map(|name| {
            let db_dir = config_root.join(name).join("Local Storage").join("leveldb");
            if !db_dir.is_dir() {
                return None;
            }
            let values = read_profile(&db_dir).ok()?;
            if values.contains_key("tournament_history_v3") || values.contains_key("tournament_hub_settings_v1") {
                Some(LegacyProfile { source: name.to_string(), values })
            } else {
                None
            }
        })
        .collect()
}

fn read_profile(db_dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let tmp = std::env::temp_dir().join(format!(
        "bracket-maker-legacy-{}-{}",
        std::process::id(),
        db_dir.to_string_lossy().len()
    ));
    let _ = fs::remove_dir_all(&tmp);
    copy_db(db_dir, &tmp)?;
    let result = read_copied_db(&tmp);
    let _ = fs::remove_dir_all(&tmp);
    result
}

fn copy_db(from: &Path, to: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == "LOCK" || !entry.path().is_file() {
            continue;
        }
        fs::copy(entry.path(), to.join(&name)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn read_copied_db(dir: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut opts = Options::default();
    opts.create_if_missing = false;
    let mut db = DB::open(dir, opts).map_err(|e| e.to_string())?;
    let mut iter = db.new_iter().map_err(|e| e.to_string())?;
    let mut out = BTreeMap::new();

    while let Some((key, value)) = iter.next() {
        let Some(name) = storage_key_name(&key) else { continue };
        if !WANTED_KEYS.contains(&name.as_str()) {
            continue;
        }
        if let Some(text) = decode_value(&value) {
            out.insert(name, text);
        }
    }
    Ok(out)
}

/// `_<origin>\0\x01<key>` → `<key>`
fn storage_key_name(key: &[u8]) -> Option<String> {
    if key.first() != Some(&b'_') {
        return None;
    }
    let sep = key.windows(2).position(|w| w == [0x00, 0x01])?;
    let raw = &key[sep + 2..];
    Some(raw.iter().map(|&b| b as char).collect())
}

fn decode_value(value: &[u8]) -> Option<String> {
    let (&tag, body) = value.split_first()?;
    match tag {
        0x01 => Some(body.iter().map(|&b| b as char).collect()),
        0x00 => {
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16(&units).ok()
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_latin1_and_utf16_values() {
        assert_eq!(decode_value(b"\x01caf\xe9").as_deref(), Some("café"));
        assert_eq!(decode_value(&[0x00, b'h', 0, b'i', 0]).as_deref(), Some("hi"));
        assert_eq!(storage_key_name(b"_file://\x00\x01h_theme").as_deref(), Some("h_theme"));
        assert_eq!(storage_key_name(b"META:file://"), None);
    }

    /// Run with `cargo test -- --ignored --nocapture` to inspect local legacy data.
    #[test]
    #[ignore]
    fn dump_local_legacy_profiles() {
        let home = std::env::var("HOME").unwrap();
        let root = PathBuf::from(home).join("Library/Application Support");
        for p in scan(&root) {
            println!("profile: {}", p.source);
            for (k, v) in &p.values {
                println!("  {k}: {} chars, starts {:?}", v.len(), &v.chars().take(80).collect::<String>());
            }
        }
    }
}
