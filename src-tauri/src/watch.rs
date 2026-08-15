use crate::{atomic_save::content_revision, error::HostError, scoped_fs::NormalizedRelativePath};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

pub type WatchEmitter = Arc<dyn Fn(FileChangeDto) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeDto {
    pub watch_id: String,
    pub project_id: String,
    pub kind: String,
    pub relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

struct WatchEventNormalizer {
    root: PathBuf,
    lexical_root: PathBuf,
    watch_id: String,
    project_id: String,
    active: AtomicBool,
    callback_gate: Mutex<()>,
    delivered: Mutex<HashMap<String, String>>,
}

impl WatchEventNormalizer {
    fn new(root: &Path, watch_id: String, project_id: String) -> Result<Self, HostError> {
        let lexical_root = root.to_path_buf();
        let root = fs::canonicalize(root).map_err(|error| {
            HostError::io(
                "read-failed",
                "Could not canonicalize the watched project root",
                &error,
            )
        })?;
        if !root.is_dir() {
            return Err(HostError::new(
                "read-failed",
                "The watched project root is not a directory.",
            ));
        }
        Ok(Self {
            root,
            lexical_root,
            watch_id,
            project_id,
            active: AtomicBool::new(true),
            callback_gate: Mutex::new(()),
            delivered: Mutex::new(HashMap::new()),
        })
    }

    fn handle_paths(&self, paths: &[PathBuf], emit: &WatchEmitter) {
        let Ok(_gate) = self.callback_gate.lock() else {
            return;
        };
        if !self.active.load(Ordering::Acquire) {
            return;
        }
        for path in paths {
            let Some(event) = self.normalize_path(path) else {
                continue;
            };
            let token = event
                .revision
                .clone()
                .unwrap_or_else(|| "<deleted>".to_string());
            let Ok(mut delivered) = self.delivered.lock() else {
                return;
            };
            if delivered.get(&event.relative_path) == Some(&token) {
                continue;
            }
            delivered.insert(event.relative_path.clone(), token);
            drop(delivered);
            if self.active.load(Ordering::Acquire) {
                emit(event);
            }
        }
    }

    fn dispose(&self) {
        if let Ok(_gate) = self.callback_gate.lock() {
            self.active.store(false, Ordering::Release);
        } else {
            self.active.store(false, Ordering::Release);
        }
    }

    fn normalize_path(&self, candidate: &Path) -> Option<FileChangeDto> {
        if candidate
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_editor_artifact_name)
        {
            return None;
        }

        match fs::symlink_metadata(candidate) {
            Ok(metadata) => {
                if metadata.is_dir() || is_symlink_or_reparse(&metadata) {
                    return None;
                }
                let canonical = fs::canonicalize(candidate).ok()?;
                let relative_path =
                    normalized_relative_string(canonical.strip_prefix(&self.root).ok()?)?;
                Some(FileChangeDto {
                    watch_id: self.watch_id.clone(),
                    project_id: self.project_id.clone(),
                    kind: "changed".to_string(),
                    relative_path,
                    revision: content_revision(&canonical).ok(),
                })
                .filter(|event| event.revision.is_some())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let relative = candidate
                    .strip_prefix(&self.lexical_root)
                    .or_else(|_| candidate.strip_prefix(&self.root))
                    .ok()?;
                let relative_path = normalized_relative_string(relative)?;
                Some(FileChangeDto {
                    watch_id: self.watch_id.clone(),
                    project_id: self.project_id.clone(),
                    kind: "deleted".to_string(),
                    relative_path,
                    revision: None,
                })
            }
            Err(_) => None,
        }
    }
}

struct ActiveWatch {
    _watcher: notify::RecommendedWatcher,
    normalizer: Arc<WatchEventNormalizer>,
}

#[derive(Default)]
pub struct WatchRegistry {
    watches: Mutex<HashMap<String, ActiveWatch>>,
    next_watch: AtomicU64,
}

impl WatchRegistry {
    pub fn start(
        &self,
        root: PathBuf,
        project_id: String,
        emit: WatchEmitter,
    ) -> Result<String, HostError> {
        let watch_id = format!(
            "watch:v1:{}-{}",
            std::process::id(),
            self.next_watch.fetch_add(1, Ordering::Relaxed)
        );
        let normalizer = Arc::new(WatchEventNormalizer::new(
            &root,
            watch_id.clone(),
            project_id,
        )?);
        let callback_normalizer = normalizer.clone();
        let callback_emit = emit.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    callback_normalizer.handle_paths(&event.paths, &callback_emit);
                }
            })
            .map_err(watch_error)?;
        watcher
            .watch(&normalizer.root, RecursiveMode::Recursive)
            .map_err(watch_error)?;
        let mut watches = self
            .watches
            .lock()
            .map_err(|_| HostError::new("read-failed", "File-watch registry is unavailable."))?;
        watches.insert(
            watch_id.clone(),
            ActiveWatch {
                _watcher: watcher,
                normalizer,
            },
        );
        Ok(watch_id)
    }

    pub fn stop(&self, watch_id: &str) -> Result<(), HostError> {
        let active = self
            .watches
            .lock()
            .map_err(|_| HostError::new("read-failed", "File-watch registry is unavailable."))?
            .remove(watch_id)
            .ok_or_else(|| HostError::new("read-failed", "File-watch identifier is not active."))?;
        active.normalizer.dispose();
        drop(active);
        Ok(())
    }

    pub fn stop_all(&self) {
        let Ok(mut watches) = self.watches.lock() else {
            return;
        };
        let active: Vec<_> = watches.drain().map(|(_, active)| active).collect();
        drop(watches);
        for watch in active {
            watch.normalizer.dispose();
        }
    }

    #[cfg(test)]
    pub fn active_count(&self) -> usize {
        self.watches
            .lock()
            .map(|watches| watches.len())
            .unwrap_or(0)
    }
}

fn normalized_relative_string(path: &Path) -> Option<String> {
    let segments: Option<Vec<_>> = path
        .components()
        .map(|component| component.as_os_str().to_str().map(str::to_owned))
        .collect();
    let candidate = segments?.join("/");
    NormalizedRelativePath::parse(&candidate).ok()?;
    Some(candidate)
}

fn is_editor_artifact_name(name: &str) -> bool {
    name.contains(".uxml-editor-") && (name.ends_with(".tmp") || name.ends_with(".bak"))
}

#[cfg(windows)]
fn is_symlink_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_symlink_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn watch_error(error: notify::Error) -> HostError {
    let _ = error;
    HostError::new("read-failed", "Native file watching failed.")
}

#[cfg(test)]
mod tests {
    use super::{watch_error, FileChangeDto, WatchEmitter, WatchEventNormalizer, WatchRegistry};
    use crate::atomic_save::content_revision;
    use std::{
        fs,
        path::PathBuf,
        sync::{
            atomic::{AtomicU64, Ordering},
            mpsc, Arc, Mutex,
        },
        time::Duration,
    };

    static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn emits_exact_revisions_and_deduplicates_repeated_changed_events() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", "<UXML label=\"日本語\" />\r\n".as_bytes());
        let (normalizer, events) = fixture.normalizer();

        normalizer.handle_paths(&[target.clone(), target.clone()], &collector(&events));
        let original_revision = content_revision(&target).unwrap();
        fs::write(&target, b"changed\r\n").unwrap();
        normalizer.handle_paths(&[target.clone(), target.clone()], &collector(&events));

        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, "changed");
        assert_eq!(events[0].relative_path, "Main.uxml");
        assert_eq!(events[0].revision, Some(original_revision));
        assert_eq!(events[1].revision, Some(content_revision(&target).unwrap()));
        assert_ne!(events[0].revision, events[1].revision);
    }

    #[test]
    fn emits_deletion_without_revision() {
        let fixture = Fixture::new();
        let target = fixture.write("Styles/Main.uss", b"old");
        let (normalizer, events) = fixture.normalizer();
        normalizer.handle_paths(std::slice::from_ref(&target), &collector(&events));
        events.lock().unwrap().clear();

        fs::remove_file(&target).unwrap();
        normalizer.handle_paths(std::slice::from_ref(&target), &collector(&events));

        assert_eq!(
            events.lock().unwrap().as_slice(),
            &[FileChangeDto {
                watch_id: "watch:v1:test".to_string(),
                project_id: "project:v1:test".to_string(),
                kind: "deleted".to_string(),
                relative_path: "Styles/Main.uss".to_string(),
                revision: None,
            }]
        );
    }

    #[test]
    fn filters_editor_artifacts_and_paths_outside_the_granted_project() {
        let fixture = Fixture::new();
        let artifact = fixture.write(".Main.uxml.uxml-editor-1-1.tmp", b"temporary");
        let backup = fixture.write(".Main.uxml.uxml-editor-1-2.bak", b"backup");
        let outside = fixture.root.parent().unwrap().join("outside.uxml");
        fs::write(&outside, b"outside").unwrap();
        let (normalizer, events) = fixture.normalizer();

        normalizer.handle_paths(&[artifact, backup, outside.clone()], &collector(&events));

        assert!(events.lock().unwrap().is_empty());
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn watch_setup_errors_do_not_expose_absolute_paths() {
        let absolute = std::env::temp_dir().join("private-project");
        let error = watch_error(notify::Error::path_not_found().add_path(absolute.clone()));

        assert_eq!(error.code, "read-failed");
        assert!(!error.message.contains("private-project"));
    }

    #[test]
    fn rename_style_atomic_writes_emit_only_the_destination() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"old");
        let temporary = fixture.write(".Main.uxml.uxml-editor-1-3.tmp", b"new\r\n");
        let (normalizer, events) = fixture.normalizer();
        fs::remove_file(&target).unwrap();
        fs::rename(&temporary, &target).unwrap();

        normalizer.handle_paths(&[temporary, target.clone()], &collector(&events));

        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].relative_path, "Main.uxml");
        assert_eq!(events[0].revision, Some(content_revision(&target).unwrap()));
    }

    #[test]
    fn normalizer_stops_synchronously_after_dispose() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"old");
        let (normalizer, events) = fixture.normalizer();
        normalizer.dispose();

        normalizer.handle_paths(std::slice::from_ref(&target), &collector(&events));

        assert!(events.lock().unwrap().is_empty());
    }

    #[test]
    fn live_watch_delivers_its_project_only_and_stays_silent_after_stop() {
        let fixture = Fixture::new();
        let registry = WatchRegistry::default();
        let (sender, receiver) = mpsc::channel();
        let emitter: WatchEmitter = Arc::new(move |event| {
            let _ = sender.send(event);
        });
        let watch_id = registry
            .start(fixture.root.clone(), "project:v1:live".to_string(), emitter)
            .unwrap();
        let target = fixture.root.join("Live.uxml");

        fs::write(&target, b"live").unwrap();
        let event = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(event.watch_id, watch_id);
        assert_eq!(event.project_id, "project:v1:live");
        assert_eq!(event.relative_path, "Live.uxml");

        registry.stop(&watch_id).unwrap();
        while receiver.try_recv().is_ok() {}
        fs::write(&target, b"after dispose").unwrap();
        assert!(receiver.recv_timeout(Duration::from_millis(500)).is_err());
    }

    fn collector(events: &Arc<Mutex<Vec<FileChangeDto>>>) -> WatchEmitter {
        let events = events.clone();
        Arc::new(move |event| events.lock().unwrap().push(event))
    }

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "uxml-editor-watch-test-{}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn write(&self, relative_path: &str, bytes: &[u8]) -> PathBuf {
            let path = self
                .root
                .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            path
        }

        fn normalizer(&self) -> (WatchEventNormalizer, Arc<Mutex<Vec<FileChangeDto>>>) {
            (
                WatchEventNormalizer::new(
                    &self.root,
                    "watch:v1:test".to_string(),
                    "project:v1:test".to_string(),
                )
                .unwrap(),
                Arc::new(Mutex::new(Vec::new())),
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
