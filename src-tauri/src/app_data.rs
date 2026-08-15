use crate::{
    atomic_save::{flush_parent_directory, replace_existing_file},
    error::HostError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

const STORAGE_VERSION: u32 = 1;
const MAX_RECENT_PROJECTS: usize = 10;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentProjectDto {
    pub project_id: String,
    pub display_name: String,
    pub last_opened_at: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryRecord {
    version: u32,
    project_id: String,
    journal: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecentProjectStore {
    version: u32,
    entries: Vec<RecentProjectDto>,
}

pub struct AppDataStore {
    root: PathBuf,
    write_lock: Mutex<()>,
    #[cfg(test)]
    fail_next_write: std::sync::atomic::AtomicBool,
}

impl AppDataStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            write_lock: Mutex::new(()),
            #[cfg(test)]
            fail_next_write: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn read_recovery(&self, project_id: &str) -> Result<Option<String>, HostError> {
        validate_project_id(project_id)?;
        let path = self.recovery_path(project_id);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(app_data_io("Could not read recovery data", &error)),
        };
        let record: RecoveryRecord = parse_record(&bytes, "recovery")?;
        if record.version != STORAGE_VERSION || record.project_id != project_id {
            return Err(HostError::new(
                "app-data-failed",
                "Recovery data has an unsupported version or project identifier.",
            ));
        }
        Ok(Some(record.journal))
    }

    pub fn write_recovery(&self, project_id: &str, journal: &str) -> Result<(), HostError> {
        validate_project_id(project_id)?;
        let record = RecoveryRecord {
            version: STORAGE_VERSION,
            project_id: project_id.to_owned(),
            journal: journal.to_owned(),
        };
        let bytes = serialize_record(&record, "recovery")?;
        let _guard = self.lock_writes()?;
        self.replace_record(&self.recovery_path(project_id), &bytes)
    }

    pub fn clear_recovery(&self, project_id: &str) -> Result<(), HostError> {
        validate_project_id(project_id)?;
        let _guard = self.lock_writes()?;
        let path = self.recovery_path(project_id);
        match fs::remove_file(&path) {
            Ok(()) => {
                if let Some(parent) = path.parent() {
                    flush_parent_directory(parent).map_err(as_app_data_error)?;
                }
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(app_data_io("Could not clear recovery data", &error)),
        }
    }

    pub fn list_recent(&self) -> Result<Vec<RecentProjectDto>, HostError> {
        Ok(self.read_recent_store()?.entries)
    }

    pub fn remember_recent(
        &self,
        project_id: &str,
        display_name: &str,
        last_opened_at: u64,
    ) -> Result<(), HostError> {
        validate_recent_entry(project_id, display_name, last_opened_at)?;
        let _guard = self.lock_writes()?;
        let mut store = self.read_recent_store()?;
        store.entries.retain(|entry| entry.project_id != project_id);
        store.entries.insert(
            0,
            RecentProjectDto {
                project_id: project_id.to_owned(),
                display_name: display_name.to_owned(),
                last_opened_at,
            },
        );
        store
            .entries
            .sort_by(|left, right| right.last_opened_at.cmp(&left.last_opened_at));
        store.entries.truncate(MAX_RECENT_PROJECTS);
        let bytes = serialize_record(&store, "recent-project")?;
        self.replace_record(&self.recent_path(), &bytes)
    }

    #[cfg(test)]
    pub fn inject_next_write_failure(&self) {
        self.fail_next_write.store(true, Ordering::Release);
    }

    fn recovery_path(&self, project_id: &str) -> PathBuf {
        let digest = Sha256::digest(project_id.as_bytes());
        self.root.join("recovery").join(format!("{digest:x}.json"))
    }

    fn recent_path(&self) -> PathBuf {
        self.root.join("recent-projects.json")
    }

    fn read_recent_store(&self) -> Result<RecentProjectStore, HostError> {
        let bytes = match fs::read(self.recent_path()) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RecentProjectStore {
                    version: STORAGE_VERSION,
                    entries: Vec::new(),
                });
            }
            Err(error) => return Err(app_data_io("Could not read recent projects", &error)),
        };
        let store: RecentProjectStore = parse_record(&bytes, "recent-project")?;
        validate_recent_store(&store)?;
        Ok(store)
    }

    fn replace_record(&self, path: &Path, bytes: &[u8]) -> Result<(), HostError> {
        let parent = path.parent().ok_or_else(|| {
            HostError::new(
                "app-data-failed",
                "App-data record has no parent directory.",
            )
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| app_data_io("Could not create the app-data directory", &error))?;
        let (mut temporary, temporary_guard) = create_unique_sibling(path)?;
        temporary
            .write_all(bytes)
            .and_then(|()| temporary.sync_all())
            .map_err(|error| app_data_io("Could not write and flush app-data", &error))?;
        drop(temporary);

        #[cfg(test)]
        if self.fail_next_write.swap(false, Ordering::AcqRel) {
            return Err(HostError::new(
                "app-data-failed",
                "Injected app-data replacement failure.",
            ));
        }

        if path.exists() {
            replace_existing_file(path, temporary_guard.path()).map_err(as_app_data_error)?;
        } else {
            fs::rename(temporary_guard.path(), path)
                .map_err(|error| app_data_io("Could not install app-data record", &error))?;
        }
        flush_parent_directory(parent).map_err(as_app_data_error)
    }

    fn lock_writes(&self) -> Result<std::sync::MutexGuard<'_, ()>, HostError> {
        self.write_lock
            .lock()
            .map_err(|_| HostError::new("app-data-failed", "App-data write lock is unavailable."))
    }
}

fn validate_project_id(project_id: &str) -> Result<(), HostError> {
    let Some(digest) = project_id.strip_prefix("project:v1:") else {
        return Err(HostError::new(
            "app-data-failed",
            "Project identifier is malformed.",
        ));
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(HostError::new(
            "app-data-failed",
            "Project identifier is malformed.",
        ));
    }
    Ok(())
}

fn validate_recent_entry(
    project_id: &str,
    display_name: &str,
    last_opened_at: u64,
) -> Result<(), HostError> {
    validate_project_id(project_id)?;
    if display_name.trim().is_empty() || last_opened_at > MAX_SAFE_INTEGER {
        return Err(HostError::new(
            "app-data-failed",
            "Recent-project entry is malformed.",
        ));
    }
    Ok(())
}

fn validate_recent_store(store: &RecentProjectStore) -> Result<(), HostError> {
    if store.version != STORAGE_VERSION || store.entries.len() > MAX_RECENT_PROJECTS {
        return Err(HostError::new(
            "app-data-failed",
            "Recent-project data has an unsupported version or size.",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for entry in &store.entries {
        validate_recent_entry(&entry.project_id, &entry.display_name, entry.last_opened_at)?;
        if !seen.insert(&entry.project_id) {
            return Err(HostError::new(
                "app-data-failed",
                "Recent-project data contains duplicate entries.",
            ));
        }
    }
    if store
        .entries
        .windows(2)
        .any(|pair| pair[0].last_opened_at < pair[1].last_opened_at)
    {
        return Err(HostError::new(
            "app-data-failed",
            "Recent-project data is not newest-first.",
        ));
    }
    Ok(())
}

fn serialize_record<T: Serialize>(record: &T, label: &str) -> Result<Vec<u8>, HostError> {
    serde_json::to_vec(record).map_err(|error| {
        HostError::new(
            "app-data-failed",
            format!("Could not serialize {label} data: {error}"),
        )
    })
}

fn parse_record<'a, T: Deserialize<'a>>(bytes: &'a [u8], label: &str) -> Result<T, HostError> {
    serde_json::from_slice(bytes).map_err(|error| {
        HostError::new(
            "app-data-failed",
            format!("Could not parse {label} data: {error}"),
        )
    })
}

fn create_unique_sibling(target: &Path) -> Result<(File, TempGuard), HostError> {
    let parent = target.parent().ok_or_else(|| {
        HostError::new(
            "app-data-failed",
            "App-data record has no parent directory.",
        )
    })?;
    let file_name = target
        .file_name()
        .ok_or_else(|| HostError::new("app-data-failed", "App-data record has no file name."))?;
    for _ in 0..64 {
        let mut temporary_name = OsString::from(".");
        temporary_name.push(file_name);
        temporary_name.push(format!(
            ".uxml-editor-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let path = parent.join(temporary_name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, TempGuard { path })),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(app_data_io(
                    "Could not create a unique app-data temporary file",
                    &error,
                ));
            }
        }
    }
    Err(HostError::new(
        "app-data-failed",
        "Could not allocate a unique app-data temporary file.",
    ))
}

fn app_data_io(context: &str, error: &std::io::Error) -> HostError {
    HostError::io("app-data-failed", context, error)
}

fn as_app_data_error(error: HostError) -> HostError {
    HostError::new("app-data-failed", error.message)
}

struct TempGuard {
    path: PathBuf,
}

impl TempGuard {
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::AppDataStore;
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn stores_versioned_exact_recovery_only_under_app_data() {
        let fixture = Fixture::new();
        let project_root = fixture.root.join("project");
        let app_data = fixture.root.join("app-data");
        fs::create_dir_all(&project_root).unwrap();
        let store = AppDataStore::new(app_data.clone());
        let project_id = project_id(1);
        let journal = "{\"version\":1,\"text\":\"日本語\\r\\n\"}\r\n";

        store.write_recovery(&project_id, journal).unwrap();

        assert_eq!(
            store.read_recovery(&project_id).unwrap(),
            Some(journal.to_string())
        );
        assert!(project_root.read_dir().unwrap().next().is_none());
        assert!(app_data.join("recovery").is_dir());
        store.clear_recovery(&project_id).unwrap();
        assert_eq!(store.read_recovery(&project_id).unwrap(), None);
    }

    #[test]
    fn preserves_prior_recovery_and_cleans_temp_when_replacement_fails() {
        let fixture = Fixture::new();
        let app_data = fixture.root.join("app-data");
        let store = AppDataStore::new(app_data.clone());
        let project_id = project_id(2);
        store.write_recovery(&project_id, "old journal").unwrap();
        store.inject_next_write_failure();

        let error = store
            .write_recovery(&project_id, "new journal")
            .unwrap_err();

        assert_eq!(error.code, "app-data-failed");
        assert_eq!(
            store.read_recovery(&project_id).unwrap(),
            Some("old journal".to_string())
        );
        assert!(artifact_names(&app_data).is_empty());
    }

    #[test]
    fn rejects_corrupt_unknown_or_wrong_version_recovery_records() {
        for record in [
            "not-json",
            r#"{"version":2,"projectId":"x","journal":"j"}"#,
            r#"{"version":1,"projectId":"x","journal":"j","absolutePath":"C:\\\\secret"}"#,
        ] {
            let fixture = Fixture::new();
            let app_data = fixture.root.join("app-data");
            let store = AppDataStore::new(app_data.clone());
            let project_id = project_id(3);
            store.write_recovery(&project_id, "valid").unwrap();
            let recovery_file = fs::read_dir(app_data.join("recovery"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            fs::write(recovery_file, record).unwrap();

            let error = store.read_recovery(&project_id).unwrap_err();
            assert_eq!(error.code, "app-data-failed");
        }
    }

    #[test]
    fn recent_projects_are_newest_first_deduplicated_bounded_and_immutable_records() {
        let fixture = Fixture::new();
        let store = AppDataStore::new(fixture.root.join("app-data"));
        for index in 0..12_u64 {
            store
                .remember_recent(
                    &project_id(index),
                    &format!("Project {index}"),
                    1_000 + index,
                )
                .unwrap();
        }
        store
            .remember_recent(&project_id(5), "Project Five", 2_000)
            .unwrap();

        let recent = store.list_recent().unwrap();

        assert_eq!(recent.len(), 10);
        assert_eq!(recent[0].project_id, project_id(5));
        assert_eq!(recent[0].display_name, "Project Five");
        assert_eq!(recent[0].last_opened_at, 2_000);
        assert_eq!(
            recent
                .iter()
                .filter(|entry| entry.project_id == project_id(5))
                .count(),
            1
        );
        assert!(recent
            .windows(2)
            .all(|pair| pair[0].last_opened_at >= pair[1].last_opened_at));
    }

    #[test]
    fn rejects_malformed_recent_storage_instead_of_silently_granting_or_repairing_it() {
        let fixture = Fixture::new();
        let app_data = fixture.root.join("app-data");
        fs::create_dir_all(&app_data).unwrap();
        fs::write(
            app_data.join("recent-projects.json"),
            r#"{"version":1,"entries":[{"projectId":"project:v1:bad","displayName":"Bad","lastOpenedAt":1,"root":"C:\\\\secret"}]}"#,
        )
        .unwrap();
        let store = AppDataStore::new(app_data);

        let error = store.list_recent().unwrap_err();

        assert_eq!(error.code, "app-data-failed");
    }

    fn project_id(index: u64) -> String {
        format!("project:v1:{index:064x}")
    }

    fn artifact_names(root: &Path) -> Vec<String> {
        let mut names = Vec::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            let Ok(entries) = fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    pending.push(entry.path());
                } else {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.contains(".uxml-editor-") {
                        names.push(name);
                    }
                }
            }
        }
        names
    }

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "uxml-editor-app-data-test-{}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
