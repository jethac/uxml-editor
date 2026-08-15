use crate::{
    app_data::{AppDataStore, RecentProjectDto},
    atomic_save::replace_text_atomically,
    desktop::CloseGate,
    error::HostError,
    scoped_fs::{ProjectRootDto, ReadTextDto, ScopedProjects},
    watch::{WatchEmitter, WatchRegistry},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRequest {
    pub project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PathRequest {
    pub project_id: String,
    pub relative_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceTextRequest {
    pub project_id: String,
    pub relative_path: String,
    pub expected_revision: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryWriteRequest {
    pub project_id: String,
    pub journal: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentProjectRequest {
    pub project_id: String,
    pub display_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchStopRequest {
    pub watch_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmationRequest {
    pub kind: ConfirmationKind,
    pub title: String,
    pub message: String,
    pub confirm_label: String,
    pub cancel_label: String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConfirmationKind {
    DiscardChanges,
    ExternalChange,
    Overwrite,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageRequest {
    pub kind: MessageKind,
    pub title: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageKind {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEnumerationDto {
    pub relative_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDto {
    pub revision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDto {
    pub journal: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStartDto {
    pub watch_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationDto {
    pub confirmed: bool,
}

pub struct HostState {
    projects: ScopedProjects,
    app_data: AppDataStore,
    project_session: Mutex<()>,
    pub watches: WatchRegistry,
    pub close_gate: CloseGate,
}

impl HostState {
    pub fn new(app_data_root: PathBuf) -> Self {
        Self {
            projects: ScopedProjects::default(),
            app_data: AppDataStore::new(app_data_root),
            project_session: Mutex::new(()),
            watches: WatchRegistry::default(),
            close_gate: CloseGate::default(),
        }
    }

    pub fn select_project(&self, path: &Path) -> Result<ProjectRootDto, HostError> {
        let _session = self.lock_project_session("selection-failed")?;
        let selected = self.projects.grant_selected(path)?;
        self.watches.stop_all();
        Ok(selected)
    }

    pub fn start_watch(
        &self,
        request: &ProjectRequest,
        emit: WatchEmitter,
    ) -> Result<WatchStartDto, HostError> {
        let _session = self.lock_project_session("read-failed")?;
        let root = self.projects.current_root(&request.project_id)?;
        Ok(WatchStartDto {
            watch_id: self.watches.start(root, request.project_id.clone(), emit)?,
        })
    }

    pub fn enumerate(&self, request: &ProjectRequest) -> Result<FileEnumerationDto, HostError> {
        Ok(FileEnumerationDto {
            relative_paths: self.projects.enumerate_files(&request.project_id)?,
        })
    }

    pub fn read(&self, request: &PathRequest) -> Result<ReadTextDto, HostError> {
        self.projects
            .read_text(&request.project_id, &request.relative_path)
    }

    pub fn replace(&self, request: &ReplaceTextRequest) -> Result<RevisionDto, HostError> {
        self.projects
            .with_file(&request.project_id, &request.relative_path, |path| {
                Ok(RevisionDto {
                    revision: replace_text_atomically(
                        path,
                        &request.expected_revision,
                        &request.text,
                    )?,
                })
            })
    }

    pub fn read_recovery(&self, request: &ProjectRequest) -> Result<RecoveryDto, HostError> {
        self.projects.current_root(&request.project_id)?;
        Ok(RecoveryDto {
            journal: self.app_data.read_recovery(&request.project_id)?,
        })
    }

    pub fn write_recovery(&self, request: &RecoveryWriteRequest) -> Result<(), HostError> {
        self.projects.current_root(&request.project_id)?;
        self.app_data
            .write_recovery(&request.project_id, &request.journal)
    }

    pub fn clear_recovery(&self, request: &ProjectRequest) -> Result<(), HostError> {
        self.projects.current_root(&request.project_id)?;
        self.app_data.clear_recovery(&request.project_id)
    }

    pub fn list_recent(&self) -> Result<Vec<RecentProjectDto>, HostError> {
        self.app_data.list_recent()
    }

    pub fn remember_recent(
        &self,
        request: &RecentProjectRequest,
        now: u64,
    ) -> Result<(), HostError> {
        self.app_data
            .remember_recent(&request.project_id, &request.display_name, now)
    }

    fn lock_project_session(
        &self,
        error_code: &'static str,
    ) -> Result<std::sync::MutexGuard<'_, ()>, HostError> {
        self.project_session
            .lock()
            .map_err(|_| HostError::new(error_code, "Project session state is unavailable."))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        FileEnumerationDto, HostState, PathRequest, ProjectRequest, RecentProjectRequest,
        RecoveryWriteRequest, ReplaceTextRequest,
    };
    use std::{
        fs,
        path::PathBuf,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, Barrier,
        },
    };

    static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn command_request_schemas_reject_unknown_fields_and_unsafe_paths() {
        assert!(serde_json::from_str::<ProjectRequest>(
            r#"{"projectId":"project:v1:test","root":"C:\\\\secret"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<ReplaceTextRequest>(
            r#"{"projectId":"p","relativePath":"Main.uxml","expectedRevision":"r","text":"x","backupPath":"C:\\\\secret"}"#
        )
        .is_err());

        let fixture = Fixture::new();
        let state = HostState::new(fixture.root.join("app-data"));
        let root = state.select_project(&fixture.project).unwrap();
        let error = state
            .read(&PathRequest {
                project_id: root.project_id,
                relative_path: "C:/secret.uxml".to_string(),
            })
            .unwrap_err();
        assert_eq!(error.code, "invalid-path");
    }

    #[test]
    fn command_errors_do_not_expose_the_granted_absolute_root() {
        let fixture = Fixture::new();
        fixture.write("Main.uxml", b"first");
        let state = HostState::new(fixture.root.join("app-data"));
        let root = state.select_project(&fixture.project).unwrap();
        let missing = state
            .read(&PathRequest {
                project_id: root.project_id.clone(),
                relative_path: "Missing.uxml".to_string(),
            })
            .unwrap_err();
        let observed = state
            .read(&PathRequest {
                project_id: root.project_id.clone(),
                relative_path: "Main.uxml".to_string(),
            })
            .unwrap();
        fixture.write("Main.uxml", b"external");
        let stale = state
            .replace(&ReplaceTextRequest {
                project_id: root.project_id,
                relative_path: "Main.uxml".to_string(),
                expected_revision: observed.revision,
                text: "local".to_string(),
            })
            .unwrap_err();
        let absolute_root = fixture.project.to_string_lossy();

        assert_eq!(missing.code, "not-found");
        assert_eq!(stale.code, "stale-revision");
        assert!(!missing.message.contains(absolute_root.as_ref()));
        assert!(!stale.message.contains(absolute_root.as_ref()));
    }

    #[test]
    fn command_fixture_composes_exact_read_replace_recovery_and_recent_behavior() {
        let fixture = Fixture::new();
        fixture.write("B.uss", b"Label {}\r\n");
        fixture.write("A.uxml", "<UXML label=\"日本語\" />\r\n".as_bytes());
        let state = HostState::new(fixture.root.join("app-data"));
        let root = state.select_project(&fixture.project).unwrap();

        let enumeration = state
            .enumerate(&ProjectRequest {
                project_id: root.project_id.clone(),
            })
            .unwrap();
        assert_eq!(enumeration.relative_paths, ["A.uxml", "B.uss"]);
        let request = PathRequest {
            project_id: root.project_id.clone(),
            relative_path: "A.uxml".to_string(),
        };
        let read = state.read(&request).unwrap();
        assert_eq!(
            read.text.as_bytes(),
            "<UXML label=\"日本語\" />\r\n".as_bytes()
        );
        let replacement = state
            .replace(&ReplaceTextRequest {
                project_id: root.project_id.clone(),
                relative_path: "A.uxml".to_string(),
                expected_revision: read.revision.clone(),
                text: "replacement\r\n".to_string(),
            })
            .unwrap();
        assert_eq!(state.read(&request).unwrap().revision, replacement.revision);
        assert_eq!(
            fs::read(fixture.project.join("A.uxml")).unwrap(),
            b"replacement\r\n"
        );
        assert_eq!(
            state
                .replace(&ReplaceTextRequest {
                    project_id: root.project_id.clone(),
                    relative_path: "A.uxml".to_string(),
                    expected_revision: read.revision,
                    text: "stale".to_string(),
                })
                .unwrap_err()
                .code,
            "stale-revision"
        );

        state
            .write_recovery(&RecoveryWriteRequest {
                project_id: root.project_id.clone(),
                journal: "journal\r\n".to_string(),
            })
            .unwrap();
        assert_eq!(
            state
                .read_recovery(&ProjectRequest {
                    project_id: root.project_id.clone(),
                })
                .unwrap()
                .journal,
            Some("journal\r\n".to_string())
        );
        state
            .remember_recent(
                &RecentProjectRequest {
                    project_id: root.project_id.clone(),
                    display_name: root.display_name.clone(),
                },
                42,
            )
            .unwrap();
        assert_eq!(state.list_recent().unwrap()[0].project_id, root.project_id);
    }

    #[test]
    fn selecting_a_new_project_revokes_the_old_project_id() {
        let fixture = Fixture::new();
        fixture.write("Main.uxml", b"first");
        let second = fixture.root.join("second");
        fs::create_dir_all(&second).unwrap();
        fs::write(second.join("Main.uxml"), b"second").unwrap();
        let state = HostState::new(fixture.root.join("app-data"));
        let first = state.select_project(&fixture.project).unwrap();
        let second = state.select_project(&second).unwrap();

        assert_eq!(
            state
                .enumerate(&ProjectRequest {
                    project_id: first.project_id,
                })
                .unwrap_err()
                .code,
            "root-not-granted"
        );
        assert_eq!(
            state
                .enumerate(&ProjectRequest {
                    project_id: second.project_id,
                })
                .unwrap()
                .relative_paths,
            ["Main.uxml"]
        );
    }

    #[test]
    fn failed_project_replacement_preserves_the_current_grant_and_watch() {
        let fixture = Fixture::new();
        fixture.write("Main.uxml", b"first");
        let state = HostState::new(fixture.root.join("app-data"));
        let current = state.select_project(&fixture.project).unwrap();
        state
            .start_watch(
                &ProjectRequest {
                    project_id: current.project_id.clone(),
                },
                Arc::new(|_| {}),
            )
            .unwrap();
        let missing = fixture.root.join("missing-project");

        let error = state.select_project(&missing).unwrap_err();

        assert_eq!(error.code, "selection-failed");
        assert_eq!(state.watches.active_count(), 1);
        assert_eq!(
            state
                .enumerate(&ProjectRequest {
                    project_id: current.project_id,
                })
                .unwrap()
                .relative_paths,
            ["Main.uxml"]
        );
    }

    #[test]
    fn recent_metadata_never_creates_a_filesystem_grant() {
        let fixture = Fixture::new();
        let state = HostState::new(fixture.root.join("app-data"));
        let ungranted_id = format!("project:v1:{:064x}", 77);

        state
            .remember_recent(
                &RecentProjectRequest {
                    project_id: ungranted_id.clone(),
                    display_name: "Previously Opened".to_string(),
                },
                100,
            )
            .unwrap();

        assert_eq!(state.list_recent().unwrap()[0].project_id, ungranted_id);
        assert_eq!(
            state
                .enumerate(&ProjectRequest {
                    project_id: ungranted_id,
                })
                .unwrap_err()
                .code,
            "root-not-granted"
        );
    }

    #[test]
    fn project_replacement_cannot_leave_a_revoked_watch_registered() {
        let fixture = Fixture::new();
        fixture.write("Main.uxml", b"first");
        let second = fixture.root.join("second");
        fs::create_dir_all(&second).unwrap();
        fs::write(second.join("Main.uxml"), b"second").unwrap();
        let state = Arc::new(HostState::new(fixture.root.join("app-data")));
        let first = state.select_project(&fixture.project).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let start_state = state.clone();
        let start_barrier = barrier.clone();
        let start = std::thread::spawn(move || {
            start_barrier.wait();
            start_state.start_watch(
                &ProjectRequest {
                    project_id: first.project_id,
                },
                Arc::new(|_| {}),
            )
        });
        let select_state = state.clone();
        let select_barrier = barrier.clone();
        let select = std::thread::spawn(move || {
            select_barrier.wait();
            select_state.select_project(&second)
        });

        barrier.wait();
        let start_result = start.join().unwrap();
        select.join().unwrap().unwrap();

        if let Err(error) = start_result {
            assert_eq!(error.code, "root-not-granted");
        }
        assert_eq!(state.watches.active_count(), 0);
    }

    #[test]
    fn command_response_serialization_matches_the_typescript_schema() {
        let json = serde_json::to_value(FileEnumerationDto {
            relative_paths: vec!["Main.uxml".to_string()],
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "relativePaths": ["Main.uxml"] }));
    }

    struct Fixture {
        root: PathBuf,
        project: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "uxml-editor-command-test-{}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            let project = root.join("project");
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&project).unwrap();
            Self { root, project }
        }

        fn write(&self, relative_path: &str, bytes: &[u8]) {
            fs::write(self.project.join(relative_path), bytes).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
