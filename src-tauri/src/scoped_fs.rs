use crate::{atomic_save::revision_for_bytes, error::HostError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::RwLock,
};

#[derive(Clone, Debug)]
pub struct NormalizedRelativePath(String);

impl NormalizedRelativePath {
    pub fn parse(candidate: &str) -> Result<Self, HostError> {
        if candidate.is_empty()
            || candidate.contains('\0')
            || candidate.contains('\\')
            || candidate.starts_with('/')
            || candidate.contains(':')
        {
            return Err(invalid_path(candidate));
        }
        let segments: Vec<_> = candidate.split('/').collect();
        if segments.is_empty()
            || segments
                .iter()
                .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
        {
            return Err(invalid_path(candidate));
        }
        Ok(Self(candidate.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRootDto {
    pub project_id: String,
    pub display_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextDto {
    pub text: String,
    pub revision: String,
}

#[derive(Clone, Debug)]
struct Grant {
    root: PathBuf,
    project_id: String,
}

#[derive(Default)]
pub struct ScopedProjects {
    current: RwLock<Option<Grant>>,
}

impl ScopedProjects {
    pub fn grant_selected(&self, root: &Path) -> Result<ProjectRootDto, HostError> {
        let canonical = fs::canonicalize(root).map_err(|error| {
            HostError::io(
                "selection-failed",
                "Could not canonicalize the selected project directory",
                &error,
            )
        })?;
        let metadata = fs::metadata(&canonical).map_err(|error| {
            HostError::io(
                "selection-failed",
                "Could not inspect the selected project directory",
                &error,
            )
        })?;
        if !metadata.is_dir() {
            return Err(HostError::new(
                "selection-failed",
                "The selected project root is not a directory.",
            ));
        }
        let display_name = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                HostError::new(
                    "selection-failed",
                    "The selected project directory has no valid display name.",
                )
            })?
            .to_string();
        let project_id = project_id_for_path(&canonical);
        let grant = Grant {
            root: canonical,
            project_id: project_id.clone(),
        };
        let mut current = self.current.write().map_err(|_| {
            HostError::new("selection-failed", "Project grant state is unavailable.")
        })?;
        *current = Some(grant);
        Ok(ProjectRootDto {
            project_id,
            display_name,
        })
    }

    pub fn enumerate_files(&self, project_id: &str) -> Result<Vec<String>, HostError> {
        self.with_grant(project_id, |grant| {
            let mut paths = Vec::new();
            collect_files(&grant.root, &grant.root, &mut paths)?;
            validate_unique_paths(&paths)?;
            paths.sort();
            Ok(paths)
        })
    }

    pub fn read_text(
        &self,
        project_id: &str,
        relative_path: &str,
    ) -> Result<ReadTextDto, HostError> {
        self.with_file(project_id, relative_path, |path| {
            let bytes = fs::read(path).map_err(|error| read_error(path, &error))?;
            let revision = revision_for_bytes(&bytes);
            let text = String::from_utf8(bytes).map_err(|_| {
                HostError::new("read-failed", "Project file is not valid UTF-8 text.")
            })?;
            Ok(ReadTextDto { text, revision })
        })
    }

    pub fn with_file<T>(
        &self,
        project_id: &str,
        relative_path: &str,
        operation: impl FnOnce(&Path) -> Result<T, HostError>,
    ) -> Result<T, HostError> {
        self.with_grant(project_id, |grant| {
            let normalized = NormalizedRelativePath::parse(relative_path)?;
            let path = resolve_existing_file(grant, &normalized)?;
            operation(&path)
        })
    }

    pub fn current_root(&self, project_id: &str) -> Result<PathBuf, HostError> {
        self.with_grant(project_id, |grant| Ok(grant.root.clone()))
    }

    fn with_grant<T>(
        &self,
        project_id: &str,
        operation: impl FnOnce(&Grant) -> Result<T, HostError>,
    ) -> Result<T, HostError> {
        let current = self.current.read().map_err(|_| {
            HostError::new("root-not-granted", "Project grant state is unavailable.")
        })?;
        let grant = current
            .as_ref()
            .filter(|grant| grant.project_id == project_id)
            .ok_or_else(|| {
                HostError::new(
                    "root-not-granted",
                    format!("Project root is not granted: {project_id}"),
                )
            })?;
        operation(grant)
    }
}

pub fn validate_unique_paths(paths: &[String]) -> Result<(), HostError> {
    let mut seen = HashSet::new();
    for path in paths {
        let key = path.to_lowercase();
        if !seen.insert(key) {
            return Err(HostError::new(
                "read-failed",
                format!("Project contains duplicate or case-colliding path: {path}"),
            ));
        }
    }
    Ok(())
}

fn collect_files(root: &Path, directory: &Path, paths: &mut Vec<String>) -> Result<(), HostError> {
    let entries = fs::read_dir(directory).map_err(|error| read_error(directory, &error))?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            HostError::io(
                "read-failed",
                "Could not enumerate a project directory entry",
                &error,
            )
        })?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| read_error(&path, &error))?;
        if is_symlink_or_reparse(&metadata) {
            return Err(HostError::new(
                "invalid-path",
                "Project entry is a symbolic link or reparse point.",
            ));
        }
        let canonical = fs::canonicalize(&path).map_err(|error| read_error(&path, &error))?;
        if !canonical.starts_with(root) {
            return Err(HostError::new(
                "invalid-path",
                "Project entry escapes the granted root.",
            ));
        }
        if metadata.is_dir() {
            collect_files(root, &canonical, paths)?;
        } else if metadata.is_file() {
            let relative = path.strip_prefix(root).map_err(|_| {
                HostError::new("invalid-path", "Project entry is outside the granted root.")
            })?;
            let relative = relative_path_string(relative)?;
            NormalizedRelativePath::parse(&relative)?;
            paths.push(relative);
        }
    }
    Ok(())
}

fn resolve_existing_file(
    grant: &Grant,
    relative: &NormalizedRelativePath,
) -> Result<PathBuf, HostError> {
    let mut candidate = grant.root.clone();
    for segment in relative.as_str().split('/') {
        candidate.push(segment);
        let metadata =
            fs::symlink_metadata(&candidate).map_err(|error| read_error(&candidate, &error))?;
        if is_symlink_or_reparse(&metadata) {
            return Err(HostError::new(
                "invalid-path",
                "Project path traverses a symbolic link or reparse point.",
            ));
        }
    }
    let canonical = fs::canonicalize(&candidate).map_err(|error| read_error(&candidate, &error))?;
    if !canonical.starts_with(&grant.root) {
        return Err(HostError::new(
            "invalid-path",
            "Project path escapes the granted root.",
        ));
    }
    if !canonical.is_file() {
        return Err(HostError::new(
            "not-found",
            format!("Project file does not exist: {}", relative.as_str()),
        ));
    }
    Ok(canonical)
}

fn relative_path_string(path: &Path) -> Result<String, HostError> {
    let mut segments = Vec::new();
    for component in path.components() {
        let segment = component
            .as_os_str()
            .to_str()
            .ok_or_else(|| HostError::new("read-failed", "Project path is not valid Unicode."))?;
        segments.push(segment);
    }
    Ok(segments.join("/"))
}

fn project_id_for_path(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hash_path(&mut hasher, path);
    format!("project:v1:{:x}", hasher.finalize())
}

#[cfg(windows)]
fn hash_path(hasher: &mut Sha256, path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    for unit in path.as_os_str().encode_wide() {
        hasher.update(unit.to_le_bytes());
    }
}

#[cfg(unix)]
fn hash_path(hasher: &mut Sha256, path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    hasher.update(path.as_os_str().as_bytes());
}

fn invalid_path(candidate: &str) -> HostError {
    HostError::new(
        "invalid-path",
        format!("Path is not a normalized project-relative file path: {candidate}"),
    )
}

fn read_error(path: &Path, error: &std::io::Error) -> HostError {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "not-found",
        std::io::ErrorKind::PermissionDenied => "permission-denied",
        _ => "read-failed",
    };
    let _ = path;
    HostError::io(code, "Could not access a project path", error)
}

fn is_symlink_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    false
}

#[cfg(test)]
mod tests {
    use super::{validate_unique_paths, NormalizedRelativePath, ScopedProjects};
    use sha2::{Digest, Sha256};
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            Arc,
        },
    };

    static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn rejects_empty_absolute_scheme_nul_parent_and_separator_ambiguity() {
        for candidate in [
            "",
            "/absolute.uxml",
            "C:/absolute.uxml",
            "file:///absolute.uxml",
            "../outside.uxml",
            "Assets/../outside.uxml",
            "Assets//Main.uxml",
            "Assets/./Main.uxml",
            "Assets\\Main.uxml",
            "Assets/\0Main.uxml",
        ] {
            let error = NormalizedRelativePath::parse(candidate).unwrap_err();
            assert_eq!(error.code, "invalid-path", "candidate: {candidate:?}");
        }
        assert_eq!(
            NormalizedRelativePath::parse("Assets/UI/Main.uxml")
                .unwrap()
                .as_str(),
            "Assets/UI/Main.uxml"
        );
    }

    #[test]
    fn grants_one_canonical_root_and_reads_exact_crlf_unicode_bytes() {
        let fixture = Fixture::new();
        fixture.write(
            "Assets/UI/Main.uxml",
            "<UXML label=\"日本語\">\r\n</UXML>\r\n",
        );
        fixture.write("Assets/zeta.uss", ".z {}\n");
        fixture.write("Assets/alpha.uss", ".a {}\n");
        let projects = ScopedProjects::default();

        let root = projects.grant_selected(&fixture.root).unwrap();
        let files = projects.enumerate_files(&root.project_id).unwrap();
        let read = projects
            .read_text(&root.project_id, "Assets/UI/Main.uxml")
            .unwrap();

        assert_eq!(
            root.display_name,
            fixture.root.file_name().unwrap().to_string_lossy()
        );
        assert!(root.project_id.starts_with("project:v1:"));
        assert!(!root
            .project_id
            .contains(&fixture.root.to_string_lossy().to_string()));
        assert_eq!(
            files,
            ["Assets/UI/Main.uxml", "Assets/alpha.uss", "Assets/zeta.uss"]
        );
        assert_eq!(read.text, "<UXML label=\"日本語\">\r\n</UXML>\r\n");
        assert!(read.revision.starts_with("sha256:v1:"));
    }

    #[test]
    fn replacing_the_session_grant_revokes_the_previous_project() {
        let first = Fixture::new();
        first.write("Main.uxml", "first");
        let second = Fixture::new();
        second.write("Main.uxml", "second");
        let projects = ScopedProjects::default();
        let first_root = projects.grant_selected(&first.root).unwrap();

        let second_root = projects.grant_selected(&second.root).unwrap();

        let error = projects
            .read_text(&first_root.project_id, "Main.uxml")
            .unwrap_err();
        assert_eq!(error.code, "root-not-granted");
        assert_eq!(
            projects
                .read_text(&second_root.project_id, "Main.uxml")
                .unwrap()
                .text,
            "second"
        );
    }

    #[test]
    fn rejects_duplicate_and_case_colliding_enumeration_paths() {
        for paths in [
            vec!["Assets/Main.uss".to_string(), "Assets/Main.uss".to_string()],
            vec!["Assets/Main.uss".to_string(), "assets/main.USS".to_string()],
        ] {
            let error = validate_unique_paths(&paths).unwrap_err();
            assert_eq!(error.code, "read-failed");
        }
    }

    #[test]
    fn rejects_symlink_or_reparse_targets_that_escape_the_grant_when_supported() {
        let project = Fixture::new();
        let outside = Fixture::new();
        outside.write("Secret.uxml", "outside");
        fs::create_dir_all(project.root.join("Assets")).unwrap();
        let link = project.root.join("Assets/Linked.uxml");
        if create_file_symlink(&outside.root.join("Secret.uxml"), &link).is_err() {
            return;
        }
        let projects = ScopedProjects::default();
        let root = projects.grant_selected(&project.root).unwrap();

        let read_error = projects
            .read_text(&root.project_id, "Assets/Linked.uxml")
            .unwrap_err();
        assert_eq!(read_error.code, "invalid-path");
        let enumerate_error = projects.enumerate_files(&root.project_id).unwrap_err();
        assert_eq!(enumerate_error.code, "invalid-path");
    }

    #[test]
    fn concurrent_reads_bind_the_revision_to_the_returned_text_bytes() {
        let fixture = Fixture::new();
        let target = fixture.root.join("Main.uxml");
        let first = vec![b'a'; 512 * 1024];
        let second = vec![b'b'; 512 * 1024];
        fs::write(&target, &first).unwrap();
        let projects = Arc::new(ScopedProjects::default());
        let root = projects.grant_selected(&fixture.root).unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let writer_running = running.clone();
        let writer_target = target.clone();
        let writer = std::thread::spawn(move || {
            while writer_running.load(Ordering::Acquire) {
                fs::write(&writer_target, &second).unwrap();
                fs::write(&writer_target, &first).unwrap();
            }
        });

        let mut mismatch = None;
        for _ in 0..128 {
            let read = projects.read_text(&root.project_id, "Main.uxml").unwrap();
            let expected = format!("sha256:v1:{:x}", Sha256::digest(read.text.as_bytes()));
            if read.revision != expected {
                mismatch = Some((read.revision, expected));
                break;
            }
        }
        running.store(false, Ordering::Release);
        writer.join().unwrap();

        assert_eq!(
            mismatch, None,
            "read text and revision came from different file versions"
        );
    }

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "uxml-editor-scope-test-{}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn write(&self, relative: &str, text: &str) {
            let path = self.root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text.as_bytes()).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[cfg(unix)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }
}
