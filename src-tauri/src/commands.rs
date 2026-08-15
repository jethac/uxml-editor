use crate::{
    app_data::{AppDataStore, RecentProjectDto},
    atomic_save::replace_text_atomically,
    desktop::{CloseGate, FileWorkflowGate},
    error::HostError,
    identifiers::{
        deserialize_grant, deserialize_project_id, deserialize_revision, deserialize_watch_id,
    },
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
    #[serde(deserialize_with = "deserialize_project_id")]
    pub project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantedProjectRequest {
    #[serde(deserialize_with = "deserialize_project_id")]
    pub project_id: String,
    #[serde(deserialize_with = "deserialize_grant")]
    pub grant: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PathRequest {
    #[serde(deserialize_with = "deserialize_project_id")]
    pub project_id: String,
    #[serde(deserialize_with = "deserialize_grant")]
    pub grant: String,
    pub relative_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceTextRequest {
    #[serde(deserialize_with = "deserialize_project_id")]
    pub project_id: String,
    #[serde(deserialize_with = "deserialize_grant")]
    pub grant: String,
    pub relative_path: String,
    #[serde(deserialize_with = "deserialize_revision")]
    pub expected_revision: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryWriteRequest {
    #[serde(deserialize_with = "deserialize_project_id")]
    pub project_id: String,
    pub journal: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentProjectRequest {
    #[serde(deserialize_with = "deserialize_project_id")]
    pub project_id: String,
    pub display_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchStopRequest {
    #[serde(deserialize_with = "deserialize_project_id")]
    pub project_id: String,
    #[serde(deserialize_with = "deserialize_grant")]
    pub grant: String,
    #[serde(deserialize_with = "deserialize_watch_id")]
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
    pub file_workflow_gate: FileWorkflowGate,
}

impl HostState {
    pub fn new(app_data_root: PathBuf) -> Self {
        Self {
            projects: ScopedProjects::default(),
            app_data: AppDataStore::new(app_data_root),
            project_session: Mutex::new(()),
            watches: WatchRegistry::default(),
            close_gate: CloseGate::default(),
            file_workflow_gate: FileWorkflowGate::default(),
        }
    }

    pub fn select_project(&self, path: &Path) -> Result<ProjectRootDto, HostError> {
        let _session = self.lock_project_session("selection-failed")?;
        let prepared = self.projects.prepare_selected(path)?;
        self.watches.stop_all()?;
        self.projects.install_selected(prepared)
    }

    pub fn start_watch(
        &self,
        request: &GrantedProjectRequest,
        emit: WatchEmitter,
    ) -> Result<WatchStartDto, HostError> {
        let _session = self.lock_project_session("read-failed")?;
        let grant = self
            .projects
            .watch_grant(&request.project_id, &request.grant)?;
        Ok(WatchStartDto {
            watch_id: self.watches.start(
                grant.root,
                grant.authority,
                request.project_id.clone(),
                request.grant.clone(),
                emit,
            )?,
        })
    }

    pub fn enumerate(
        &self,
        request: &GrantedProjectRequest,
    ) -> Result<FileEnumerationDto, HostError> {
        Ok(FileEnumerationDto {
            relative_paths: self
                .projects
                .enumerate_files(&request.project_id, &request.grant)?,
        })
    }

    pub fn read(&self, request: &PathRequest) -> Result<ReadTextDto, HostError> {
        self.projects
            .read_text(&request.project_id, &request.grant, &request.relative_path)
    }

    pub fn replace(&self, request: &ReplaceTextRequest) -> Result<RevisionDto, HostError> {
        self.projects.with_replace_file(
            &request.project_id,
            &request.grant,
            &request.relative_path,
            |(parent, file_name)| {
                Ok(RevisionDto {
                    revision: replace_text_atomically(
                        parent,
                        file_name,
                        &request.expected_revision,
                        &request.text,
                    )?,
                })
            },
        )
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
        FileEnumerationDto, GrantedProjectRequest, HostState, PathRequest, ProjectRequest,
        RecentProjectRequest, RecoveryWriteRequest, ReplaceTextRequest, WatchStopRequest,
    };
    use std::{
        fs,
        path::PathBuf,
        sync::{
            atomic::{AtomicU64, Ordering},
            mpsc, Arc, Barrier, Mutex,
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
                grant: root.grant,
                relative_path: "C:/secret.uxml".to_string(),
            })
            .unwrap_err();
        assert_eq!(error.code, "invalid-path");
    }

    #[test]
    fn filesystem_request_schemas_require_exact_project_grant_revision_and_watch_ids() {
        let project_id = format!("project:v1:{}", "a".repeat(64));
        let grant = format!("grant:v1:{}", "b".repeat(16));
        let revision = format!("sha256:v1:{}", "c".repeat(64));
        let watch_id = format!("watch:v1:{}", "d".repeat(16));

        assert!(
            serde_json::from_value::<GrantedProjectRequest>(serde_json::json!({
                "projectId": project_id,
                "grant": grant,
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<ReplaceTextRequest>(serde_json::json!({
                "projectId": format!("project:v1:{}", "a".repeat(64)),
                "grant": format!("grant:v1:{}", "b".repeat(16)),
                "relativePath": "Main.uxml",
                "expectedRevision": revision,
                "text": "replacement",
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<WatchStopRequest>(serde_json::json!({
                "projectId": format!("project:v1:{}", "a".repeat(64)),
                "grant": format!("grant:v1:{}", "b".repeat(16)),
                "watchId": watch_id,
            }))
            .is_ok()
        );

        for malformed in [
            serde_json::json!({ "projectId": "project:v1:short", "grant": format!("grant:v1:{}", "b".repeat(16)) }),
            serde_json::json!({ "projectId": format!("project:v1:{}", "A".repeat(64)), "grant": format!("grant:v1:{}", "b".repeat(16)) }),
            serde_json::json!({ "projectId": format!("project:v1:{}", "a".repeat(64)), "grant": "grant:v1:short" }),
        ] {
            assert!(serde_json::from_value::<GrantedProjectRequest>(malformed).is_err());
        }
    }

    #[test]
    fn project_selection_serializes_a_distinct_exact_grant_token() {
        let fixture = Fixture::new();
        let state = HostState::new(fixture.root.join("app-data"));

        let selected =
            serde_json::to_value(state.select_project(&fixture.project).unwrap()).unwrap();

        assert_eq!(
            selected["projectId"].as_str().unwrap().len(),
            "project:v1:".len() + 64
        );
        let grant = selected["grant"].as_str().unwrap();
        assert!(grant.starts_with("grant:v1:"));
        assert_eq!(grant.len(), "grant:v1:".len() + 16);
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
                grant: root.grant.clone(),
                relative_path: "Missing.uxml".to_string(),
            })
            .unwrap_err();
        let observed = state
            .read(&PathRequest {
                project_id: root.project_id.clone(),
                grant: root.grant.clone(),
                relative_path: "Main.uxml".to_string(),
            })
            .unwrap();
        fixture.write("Main.uxml", b"external");
        let stale = state
            .replace(&ReplaceTextRequest {
                project_id: root.project_id,
                grant: root.grant,
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
            .enumerate(&GrantedProjectRequest {
                project_id: root.project_id.clone(),
                grant: root.grant.clone(),
            })
            .unwrap();
        assert_eq!(enumeration.relative_paths, ["A.uxml", "B.uss"]);
        let request = PathRequest {
            project_id: root.project_id.clone(),
            grant: root.grant.clone(),
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
                grant: root.grant.clone(),
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
                    grant: root.grant.clone(),
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
                .enumerate(&GrantedProjectRequest {
                    project_id: first.project_id,
                    grant: first.grant,
                })
                .unwrap_err()
                .code,
            "root-not-granted"
        );
        assert_eq!(
            state
                .enumerate(&GrantedProjectRequest {
                    project_id: second.project_id,
                    grant: second.grant,
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
                &GrantedProjectRequest {
                    project_id: current.project_id.clone(),
                    grant: current.grant.clone(),
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
                .enumerate(&GrantedProjectRequest {
                    project_id: current.project_id,
                    grant: current.grant,
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
                .enumerate(&GrantedProjectRequest {
                    project_id: ungranted_id,
                    grant: format!("grant:v1:{:016x}", 1),
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
                &GrantedProjectRequest {
                    project_id: first.project_id,
                    grant: first.grant,
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
    fn successful_project_replacement_drains_old_watch_callbacks_before_grant_publication() {
        let fixture = Fixture::new();
        fixture.write("Main.uxml", b"first");
        let second = fixture.root.join("second-drain");
        fs::create_dir_all(&second).unwrap();
        fs::write(second.join("Main.uxml"), b"second").unwrap();
        let state = Arc::new(HostState::new(fixture.root.join("app-data")));
        let first = state.select_project(&fixture.project).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let callback_release = release_rx.clone();
        let watch = state
            .start_watch(
                &GrantedProjectRequest {
                    project_id: first.project_id.clone(),
                    grant: first.grant.clone(),
                },
                Arc::new(move |_| {
                    let _ = started_tx.send(());
                    let _ = callback_release.lock().unwrap().recv();
                }),
            )
            .unwrap();
        let dispatch_state = state.clone();
        let target = state
            .projects
            .current_root(&first.project_id)
            .unwrap()
            .join("Main.uxml");
        let dispatch = std::thread::spawn(move || {
            dispatch_state
                .watches
                .dispatch_paths(&watch.watch_id, &[target])
        });
        started_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();

        let selection_state = state.clone();
        let selection = std::thread::spawn(move || selection_state.select_project(&second));
        for _ in 0..100 {
            if state.watches.active_count() == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(state.watches.active_count(), 0);
        assert_eq!(
            state
                .enumerate(&GrantedProjectRequest {
                    project_id: first.project_id.clone(),
                    grant: first.grant.clone(),
                })
                .unwrap()
                .relative_paths,
            ["Main.uxml"]
        );

        release_tx.send(()).unwrap();
        dispatch.join().unwrap().unwrap();
        let current = selection.join().unwrap().unwrap();
        assert_ne!(current.grant, first.grant);
        assert_eq!(
            state
                .enumerate(&GrantedProjectRequest {
                    project_id: first.project_id,
                    grant: first.grant,
                })
                .unwrap_err()
                .code,
            "root-not-granted"
        );
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
