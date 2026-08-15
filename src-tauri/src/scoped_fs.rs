use crate::{
    atomic_save::{recover_atomic_artifacts, revision_for_bytes},
    error::HostError,
};
use cap_std::{ambient_authority, fs::Dir};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        RwLock,
    },
};

static NEXT_GRANT: AtomicU64 = AtomicU64::new(1);

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
    pub grant: String,
    pub atomic_replace: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextDto {
    pub text: String,
    pub revision: String,
}

struct Grant {
    authority: Dir,
    root: PathBuf,
    project_id: String,
    token: String,
    atomic_replace: AtomicReplaceSupport,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AtomicReplaceSupport {
    BestEffortSafeWrite,
    Unsupported,
}

impl AtomicReplaceSupport {
    fn as_str(self) -> &'static str {
        match self {
            Self::BestEffortSafeWrite => "best-effort-safe-write",
            Self::Unsupported => "unsupported",
        }
    }
}

pub struct PreparedGrant {
    grant: Grant,
    root: ProjectRootDto,
}

pub struct WatchGrant {
    pub authority: Dir,
    pub root: PathBuf,
}

#[derive(Default)]
pub struct ScopedProjects {
    current: RwLock<Option<Grant>>,
}

impl ScopedProjects {
    #[cfg(test)]
    pub fn grant_selected(&self, root: &Path) -> Result<ProjectRootDto, HostError> {
        let prepared = self.prepare_selected(root)?;
        self.install_selected(prepared)
    }

    pub fn prepare_selected(&self, root: &Path) -> Result<PreparedGrant, HostError> {
        self.prepare_selected_impl(root, None, None)
    }

    #[cfg(test)]
    fn prepare_selected_after_validation_hook(
        &self,
        root: &Path,
        hook: impl FnOnce(),
    ) -> Result<PreparedGrant, HostError> {
        self.prepare_selected_impl(root, Some(Box::new(hook)), None)
    }

    #[cfg(test)]
    fn grant_selected_with_atomic_replace_support(
        &self,
        root: &Path,
        support: AtomicReplaceSupport,
    ) -> Result<ProjectRootDto, HostError> {
        let prepared = self.prepare_selected_impl(root, None, Some(support))?;
        self.install_selected(prepared)
    }

    fn prepare_selected_impl(
        &self,
        root: &Path,
        #[cfg_attr(not(test), allow(unused_variables))] after_validation: Option<
            Box<dyn FnOnce() + '_>,
        >,
        replacement_support: Option<AtomicReplaceSupport>,
    ) -> Result<PreparedGrant, HostError> {
        let authority = Dir::open_ambient_dir(root, ambient_authority()).map_err(|error| {
            HostError::io(
                "selection-failed",
                "Could not open the selected project capability",
                &error,
            )
        })?;
        let authority_metadata = authority.dir_metadata().map_err(|error| {
            HostError::io(
                "selection-failed",
                "Could not inspect the selected project capability",
                &error,
            )
        })?;
        if !authority_metadata.is_dir() {
            return Err(HostError::new(
                "selection-failed",
                "The selected project root is not a directory.",
            ));
        }
        #[cfg(test)]
        if let Some(hook) = after_validation {
            hook();
        }
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
        if !metadata.is_dir()
            || !same_directory_identity(&authority, &authority_metadata, &canonical, &metadata)
        {
            return Err(HostError::new(
                "selection-failed",
                "The selected project directory changed while it was being granted.",
            ));
        }
        let atomic_replace =
            replacement_support.unwrap_or_else(|| atomic_replace_support(&authority));
        recover_atomic_artifacts(&authority)?;
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
        let token = next_grant_token();
        let grant = Grant {
            authority,
            root: canonical,
            project_id: project_id.clone(),
            token: token.clone(),
            atomic_replace,
        };
        Ok(PreparedGrant {
            grant,
            root: ProjectRootDto {
                project_id,
                display_name,
                grant: token,
                atomic_replace: atomic_replace.as_str(),
            },
        })
    }

    pub fn install_selected(&self, prepared: PreparedGrant) -> Result<ProjectRootDto, HostError> {
        let mut current = self.current.write().map_err(|_| {
            HostError::new("selection-failed", "Project grant state is unavailable.")
        })?;
        *current = Some(prepared.grant);
        Ok(prepared.root)
    }

    pub fn enumerate_files(&self, project_id: &str, token: &str) -> Result<Vec<String>, HostError> {
        self.with_grant(project_id, token, |grant| {
            let mut paths = Vec::new();
            collect_files(&grant.authority, Path::new(""), &mut paths)?;
            validate_unique_paths(&paths)?;
            paths.sort();
            Ok(paths)
        })
    }

    pub fn read_text(
        &self,
        project_id: &str,
        token: &str,
        relative_path: &str,
    ) -> Result<ReadTextDto, HostError> {
        self.with_file(project_id, token, relative_path, |path| {
            let mut file = path
                .0
                .open(path.1)
                .map_err(|error| read_error(path.1, &error))?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|error| read_error(path.1, &error))?;
            let revision = revision_for_bytes(&bytes);
            let text = String::from_utf8(bytes).map_err(|_| {
                HostError::new("read-failed", "Project file is not valid UTF-8 text.")
            })?;
            Ok(ReadTextDto { text, revision })
        })
    }

    #[cfg(test)]
    fn read_text_after_authorization_hook(
        &self,
        project_id: &str,
        token: &str,
        relative_path: &str,
        hook: impl FnOnce(),
    ) -> Result<ReadTextDto, HostError> {
        self.with_file(project_id, token, relative_path, |path| {
            hook();
            let mut file = path
                .0
                .open(path.1)
                .map_err(|error| read_error(path.1, &error))?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|error| read_error(path.1, &error))?;
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
        token: &str,
        relative_path: &str,
        operation: impl FnOnce((&Dir, &Path)) -> Result<T, HostError>,
    ) -> Result<T, HostError> {
        self.with_grant(project_id, token, |grant| {
            let normalized = NormalizedRelativePath::parse(relative_path)?;
            let (parent, file_name) = open_existing_file_parent(grant, &normalized)?;
            operation((&parent, file_name.as_path()))
        })
    }

    pub fn with_replace_file<T>(
        &self,
        project_id: &str,
        token: &str,
        relative_path: &str,
        operation: impl FnOnce((&Dir, &Path)) -> Result<T, HostError>,
    ) -> Result<T, HostError> {
        self.with_grant(project_id, token, |grant| {
            if grant.atomic_replace != AtomicReplaceSupport::BestEffortSafeWrite {
                return Err(HostError::new(
                    "unsupported",
                    "Native conditional replacement is unsupported for this project root.",
                ));
            }
            let normalized = NormalizedRelativePath::parse(relative_path)?;
            let (parent, file_name) = open_existing_file_parent(grant, &normalized)?;
            operation((&parent, file_name.as_path()))
        })
    }

    pub fn current_root(&self, project_id: &str) -> Result<PathBuf, HostError> {
        self.with_project(project_id, |grant| Ok(grant.root.clone()))
    }

    pub fn watch_grant(&self, project_id: &str, token: &str) -> Result<WatchGrant, HostError> {
        self.with_grant(project_id, token, |grant| {
            Ok(WatchGrant {
                authority: grant.authority.try_clone().map_err(|error| {
                    HostError::io(
                        "read-failed",
                        "Could not clone the project capability",
                        &error,
                    )
                })?,
                root: grant.root.clone(),
            })
        })
    }

    fn with_grant<T>(
        &self,
        project_id: &str,
        token: &str,
        operation: impl FnOnce(&Grant) -> Result<T, HostError>,
    ) -> Result<T, HostError> {
        self.with_project(project_id, |grant| {
            if grant.token != token {
                return Err(HostError::new(
                    "root-not-granted",
                    "Project grant is no longer current.",
                ));
            }
            operation(grant)
        })
    }

    fn with_project<T>(
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

#[cfg(windows)]
fn atomic_replace_support(authority: &Dir) -> AtomicReplaceSupport {
    let filesystem = filesystem_name_from_handle(authority);
    atomic_replace_capability_from_filesystem(filesystem.as_deref())
}

#[cfg(not(windows))]
fn atomic_replace_support(_authority: &Dir) -> AtomicReplaceSupport {
    AtomicReplaceSupport::Unsupported
}

fn atomic_replace_capability_from_filesystem(filesystem: Option<&str>) -> AtomicReplaceSupport {
    #[cfg(windows)]
    if filesystem.is_some_and(|name| name.eq_ignore_ascii_case("NTFS")) {
        return AtomicReplaceSupport::BestEffortSafeWrite;
    }
    let _ = filesystem;
    AtomicReplaceSupport::Unsupported
}

#[cfg(windows)]
fn filesystem_name_from_handle(authority: &Dir) -> Option<String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationByHandleW;

    let mut filesystem = [0_u16; 32];
    // SAFETY: the directory handle remains live and `filesystem` is a writable UTF-16 buffer.
    let succeeded = unsafe {
        GetVolumeInformationByHandleW(
            authority.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    };
    if succeeded == 0 {
        return None;
    }
    let length = filesystem.iter().position(|unit| *unit == 0)?;
    String::from_utf16(&filesystem[..length]).ok()
}

#[cfg(unix)]
fn same_directory_identity(
    _authority: &Dir,
    capability: &cap_std::fs::Metadata,
    _canonical: &Path,
    ambient: &std::fs::Metadata,
) -> bool {
    use cap_std::fs::MetadataExt as CapMetadataExt;
    use std::os::unix::fs::MetadataExt as StdMetadataExt;

    capability.dev() == ambient.dev() && capability.ino() == ambient.ino()
}

#[cfg(windows)]
fn same_directory_identity(
    authority: &Dir,
    _capability: &cap_std::fs::Metadata,
    canonical: &Path,
    _ambient: &std::fs::Metadata,
) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };

    let handle = authority.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    // SAFETY: `handle` remains owned by `authority`, and the first call only queries the size.
    let required = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            std::ptr::null_mut(),
            0,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if required == 0 {
        return false;
    }
    let mut buffer = vec![0_u16; required as usize + 1];
    // SAFETY: `buffer` is writable for the advertised capacity and `handle` stays valid.
    let written = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return false;
    }
    let acquired = String::from_utf16_lossy(&buffer[..written as usize]);
    normalize_windows_identity_path(&acquired)
        == normalize_windows_identity_path(canonical.to_string_lossy().as_ref())
}

#[cfg(windows)]
fn normalize_windows_identity_path(path: &str) -> String {
    let without_prefix = path.strip_prefix(r"\\?\").unwrap_or(path);
    without_prefix.replace('/', r"\").to_lowercase()
}

fn next_grant_token() -> String {
    let sequence = NEXT_GRANT.fetch_add(1, Ordering::Relaxed);
    format!("grant:v1:{sequence:016x}")
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

fn collect_files(directory: &Dir, prefix: &Path, paths: &mut Vec<String>) -> Result<(), HostError> {
    let entries = directory
        .entries()
        .map_err(|error| read_error(prefix, &error))?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            HostError::io(
                "read-failed",
                "Could not enumerate a project directory entry",
                &error,
            )
        })?;
        let file_name = entry.file_name();
        let file_type = entry
            .file_type()
            .map_err(|error| read_error(Path::new(&file_name), &error))?;
        let metadata = entry
            .metadata()
            .map_err(|error| read_error(Path::new(&file_name), &error))?;
        if file_type.is_symlink() || is_reparse_point(&metadata) {
            return Err(HostError::new(
                "invalid-path",
                "Project entry is a symbolic link or reparse point.",
            ));
        }
        let relative = prefix.join(&file_name);
        if file_type.is_dir() {
            let child = open_project_child_directory(directory, Path::new(&file_name))
                .map_err(|error| read_error(&relative, &error))?;
            collect_files(&child, &relative, paths)?;
        } else if file_type.is_file() {
            let relative = relative_path_string(&relative)?;
            NormalizedRelativePath::parse(&relative)?;
            paths.push(relative);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn open_project_child_directory(parent: &Dir, name: &Path) -> std::io::Result<Dir> {
    use cap_std::fs::{OpenOptions, OpenOptionsExt};
    use std::{mem, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let mut options = OpenOptions::new();
    options
        .read(true)
        .access_mode(FILE_GENERIC_READ)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    let file = parent.open_with(name, &options)?;
    let mut information = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: `information` is the exact writable buffer for FileAttributeTagInfo.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            (&raw mut information).cast(),
            mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    if information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "project directory is a reparse object",
        ));
    }
    if information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "project entry is not a directory",
        ));
    }
    Ok(Dir::from_std_file(file.into_std()))
}

#[cfg(not(windows))]
fn open_project_child_directory(parent: &Dir, name: &Path) -> std::io::Result<Dir> {
    parent.open_dir(name)
}

fn open_existing_file_parent(
    grant: &Grant,
    relative: &NormalizedRelativePath,
) -> Result<(Dir, PathBuf), HostError> {
    let relative = Path::new(relative.as_str());
    let parent_path = relative.parent().unwrap_or_else(|| Path::new(""));
    let file_name = relative
        .file_name()
        .ok_or_else(|| invalid_path(relative.to_string_lossy().as_ref()))?;
    let parent = if parent_path.as_os_str().is_empty() {
        grant.authority.try_clone()
    } else {
        grant.authority.open_dir(parent_path)
    }
    .map_err(|error| read_error(parent_path, &error))?;
    let metadata = parent
        .symlink_metadata(file_name)
        .map_err(|error| read_error(relative, &error))?;
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(HostError::new(
            "invalid-path",
            "Project path traverses a symbolic link or reparse point.",
        ));
    }
    if !metadata.is_file() {
        return Err(HostError::new(
            "not-found",
            format!("Project file does not exist: {}", relative.display()),
        ));
    }
    Ok((parent, PathBuf::from(file_name)))
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

fn is_reparse_point(metadata: &cap_std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    false
}

#[cfg(test)]
mod tests {
    use super::{
        atomic_replace_capability_from_filesystem, validate_unique_paths, AtomicReplaceSupport,
        NormalizedRelativePath, ScopedProjects,
    };
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
        let files = projects
            .enumerate_files(&root.project_id, &root.grant)
            .unwrap();
        let read = projects
            .read_text(&root.project_id, &root.grant, "Assets/UI/Main.uxml")
            .unwrap();

        assert_eq!(
            root.display_name,
            fixture.root.file_name().unwrap().to_string_lossy()
        );
        assert!(root.project_id.starts_with("project:v1:"));
        #[cfg(windows)]
        assert_eq!(root.atomic_replace, "best-effort-safe-write");
        #[cfg(not(windows))]
        assert_eq!(root.atomic_replace, "unsupported");
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
            .read_text(&first_root.project_id, &first_root.grant, "Main.uxml")
            .unwrap_err();
        assert_eq!(error.code, "root-not-granted");
        assert_eq!(
            projects
                .read_text(&second_root.project_id, &second_root.grant, "Main.uxml")
                .unwrap()
                .text,
            "second"
        );
    }

    #[test]
    fn reselecting_the_same_stable_project_invalidates_the_previous_grant_token() {
        let fixture = Fixture::new();
        fixture.write("Main.uxml", "same project");
        let projects = ScopedProjects::default();
        let previous = projects.grant_selected(&fixture.root).unwrap();
        let current = projects.grant_selected(&fixture.root).unwrap();

        assert_eq!(previous.project_id, current.project_id);
        assert_ne!(previous.grant, current.grant);
        assert_eq!(
            projects
                .read_text(&previous.project_id, &previous.grant, "Main.uxml")
                .unwrap_err()
                .code,
            "root-not-granted"
        );
        assert_eq!(
            projects
                .read_text(&current.project_id, &current.grant, "Main.uxml")
                .unwrap()
                .text,
            "same project"
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

    #[cfg(windows)]
    #[test]
    fn replacement_capability_requires_a_successful_handle_derived_ntfs_classification() {
        assert_eq!(
            atomic_replace_capability_from_filesystem(Some("NTFS")),
            AtomicReplaceSupport::BestEffortSafeWrite
        );
        for filesystem in [None, Some("ReFS"), Some("SMB"), Some(""), Some("unknown")] {
            assert_eq!(
                atomic_replace_capability_from_filesystem(filesystem),
                AtomicReplaceSupport::Unsupported,
                "filesystem: {filesystem:?}"
            );
        }
    }

    #[test]
    fn an_unsupported_grant_rejects_replacement_before_entering_the_mutation_closure() {
        let fixture = Fixture::new();
        fixture.write("Main.uxml", "original");
        let projects = ScopedProjects::default();
        let root = projects
            .grant_selected_with_atomic_replace_support(
                &fixture.root,
                AtomicReplaceSupport::Unsupported,
            )
            .unwrap();
        let entered = std::cell::Cell::new(false);

        let error = projects
            .with_replace_file(&root.project_id, &root.grant, "Main.uxml", |_| {
                entered.set(true);
                Ok(())
            })
            .unwrap_err();

        assert_eq!(root.atomic_replace, "unsupported");
        assert_eq!(error.code, "unsupported");
        assert!(!entered.get());
        assert_eq!(
            fs::read_to_string(fixture.root.join("Main.uxml")).unwrap(),
            "original"
        );
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
            .read_text(&root.project_id, &root.grant, "Assets/Linked.uxml")
            .unwrap_err();
        assert_eq!(read_error.code, "invalid-path");
        let enumerate_error = projects
            .enumerate_files(&root.project_id, &root.grant)
            .unwrap_err();
        assert_eq!(enumerate_error.code, "invalid-path");
    }

    #[test]
    fn authorized_multi_component_read_never_follows_a_concurrent_directory_swap() {
        let project = Fixture::new();
        let outside = Fixture::new();
        project.write("Assets/Main.uxml", "inside");
        outside.write("Main.uxml", "outside");
        let projects = ScopedProjects::default();
        let root = projects.grant_selected(&project.root).unwrap();
        let assets = project.root.join("Assets");
        let original_assets = project.root.join("Assets-original");
        let swap_prevented = std::cell::Cell::new(false);

        let result = projects.read_text_after_authorization_hook(
            &root.project_id,
            &root.grant,
            "Assets/Main.uxml",
            || {
                if fs::rename(&assets, &original_assets).is_err() {
                    swap_prevented.set(true);
                    return;
                }
                if create_dir_symlink(&outside.root, &assets).is_err() {
                    fs::rename(&original_assets, &assets).unwrap();
                }
            },
        );

        if swap_prevented.get() {
            assert_eq!(result.unwrap().text, "inside");
        } else if fs::symlink_metadata(&assets)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            remove_dir_symlink(&assets).unwrap();
            fs::rename(&original_assets, &assets).unwrap();
            if let Ok(read) = result {
                assert_ne!(read.text, "outside");
            }
        }
    }

    #[test]
    fn selected_root_capability_cannot_be_redirected_after_validation() {
        let parent = Fixture::new();
        let selected = parent.root.join("selected");
        let original = parent.root.join("selected-original");
        fs::create_dir_all(&selected).unwrap();
        fs::write(selected.join("Main.uxml"), "inside").unwrap();
        let projects = ScopedProjects::default();
        let swapped = std::cell::Cell::new(false);

        let prepared = projects.prepare_selected_after_validation_hook(&selected, || {
            if fs::rename(&selected, &original).is_ok() {
                fs::create_dir_all(&selected).unwrap();
                fs::write(selected.join("Main.uxml"), "outside").unwrap();
                swapped.set(true);
            }
        });

        match prepared {
            Ok(prepared) => {
                let root = projects.install_selected(prepared).unwrap();
                let read = projects
                    .read_text(&root.project_id, &root.grant, "Main.uxml")
                    .unwrap();
                assert_eq!(read.text, "inside", "the swapped root gained authority");
            }
            Err(error) => {
                assert!(swapped.get(), "selection failed without a successful swap");
                assert_eq!(error.code, "selection-failed");
            }
        }
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
            let read = projects
                .read_text(&root.project_id, &root.grant, "Main.uxml")
                .unwrap();
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

    #[cfg(windows)]
    #[test]
    fn project_acquisition_restores_an_absent_target_from_a_crash_quarantine() {
        let fixture = Fixture::new();
        fixture.write(".Main.uxml.uxml-editor-42-7.bak", "crash-original");
        let projects = ScopedProjects::default();

        let root = projects.grant_selected(&fixture.root).unwrap();
        let read = projects
            .read_text(&root.project_id, &root.grant, "Main.uxml")
            .unwrap();

        assert_eq!(read.text, "crash-original");
        assert!(!fixture
            .root
            .join(".Main.uxml.uxml-editor-42-7.bak")
            .exists());
    }

    #[cfg(windows)]
    #[test]
    fn project_acquisition_surfaces_a_target_backup_conflict_without_deleting_either() {
        let fixture = Fixture::new();
        fixture.write("Main.uxml", "installed-editor-bytes");
        fixture.write(".Main.uxml.uxml-editor-42-8.bak", "original-external-bytes");
        let projects = ScopedProjects::default();

        let error = projects.grant_selected(&fixture.root).unwrap_err();

        assert_eq!(error.code, "replace-failed");
        assert!(error.message.contains(".Main.uxml.uxml-editor-42-8.bak"));
        assert_eq!(
            fs::read_to_string(fixture.root.join("Main.uxml")).unwrap(),
            "installed-editor-bytes"
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join(".Main.uxml.uxml-editor-42-8.bak")).unwrap(),
            "original-external-bytes"
        );
    }

    #[test]
    fn project_acquisition_never_deletes_an_unauthenticated_collided_temporary() {
        let fixture = Fixture::new();
        fixture.write("Main.uxml", "project-bytes");
        fixture.write(".Main.uxml.uxml-editor-42-9.tmp", "user-owned-collision");
        let projects = ScopedProjects::default();

        let error = projects.grant_selected(&fixture.root).unwrap_err();

        assert_eq!(error.code, "replace-failed");
        assert!(error.message.contains(".Main.uxml.uxml-editor-42-9.tmp"));
        assert_eq!(
            fs::read_to_string(fixture.root.join(".Main.uxml.uxml-editor-42-9.tmp")).unwrap(),
            "user-owned-collision"
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join("Main.uxml")).unwrap(),
            "project-bytes"
        );
    }

    #[cfg(windows)]
    #[test]
    fn interrupted_absent_target_recovery_is_idempotent_when_names_share_identity() {
        let fixture = Fixture::new();
        let backup = fixture.root.join(".Main.uxml.uxml-editor-42-10.bak");
        fixture.write(".Main.uxml.uxml-editor-42-10.bak", "crash-original");
        fs::hard_link(&backup, fixture.root.join("Main.uxml")).unwrap();
        let projects = ScopedProjects::default();

        let first = projects.grant_selected(&fixture.root).unwrap();
        assert_eq!(
            projects
                .read_text(&first.project_id, &first.grant, "Main.uxml")
                .unwrap()
                .text,
            "crash-original"
        );
        assert!(!backup.exists());

        let second = projects.grant_selected(&fixture.root).unwrap();
        assert_eq!(
            projects
                .read_text(&second.project_id, &second.grant, "Main.uxml")
                .unwrap()
                .text,
            "crash-original"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_backup_recovery_is_unsupported_and_never_mutates_artifacts() {
        for with_target in [false, true] {
            let fixture = Fixture::new();
            let backup_name = ".Main.uxml.uxml-editor-42-14.bak";
            fixture.write(backup_name, "retained-original");
            if with_target {
                fixture.write("Main.uxml", "installed-result");
            }
            let projects = ScopedProjects::default();

            let error = projects.grant_selected(&fixture.root).unwrap_err();

            assert_eq!(error.code, "unsupported");
            assert!(error.message.contains(backup_name));
            assert_eq!(
                fs::read_to_string(fixture.root.join(backup_name)).unwrap(),
                "retained-original"
            );
            if with_target {
                assert_eq!(
                    fs::read_to_string(fixture.root.join("Main.uxml")).unwrap(),
                    "installed-result"
                );
            } else {
                assert!(!fixture.root.join("Main.uxml").exists());
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn project_acquisition_never_follows_a_target_symlink_to_authorize_backup_deletion() {
        let fixture = Fixture::new();
        let backup_name = ".Main.uxml.uxml-editor-42-12.bak";
        let backup = fixture.root.join(backup_name);
        let target = fixture.root.join("Main.uxml");
        fixture.write(backup_name, "sole-original-bytes");
        if std::os::windows::fs::symlink_file(Path::new(backup_name), &target).is_err() {
            return;
        }
        let projects = ScopedProjects::default();

        let error = projects.grant_selected(&fixture.root).unwrap_err();

        assert_eq!(error.code, "replace-failed");
        assert!(error.message.contains(backup_name));
        assert_eq!(fs::read_to_string(&backup).unwrap(), "sole-original-bytes");
        assert!(fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(windows)]
    #[test]
    fn failed_same_identity_recovery_cleanup_retains_and_names_the_relative_artifact() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

        let fixture = Fixture::new();
        let backup_name = ".Main.uxml.uxml-editor-42-11.bak";
        let backup = fixture.root.join(backup_name);
        fixture.write(backup_name, "crash-original");
        fs::hard_link(&backup, fixture.root.join("Main.uxml")).unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&backup)
            .unwrap();
        let projects = ScopedProjects::default();

        let error = projects.grant_selected(&fixture.root).unwrap_err();

        assert_eq!(error.code, "replace-failed");
        assert!(error.message.contains(backup_name));
        assert!(!error
            .message
            .contains(&fixture.root.to_string_lossy().to_string()));
        assert_eq!(fs::read_to_string(&backup).unwrap(), "crash-original");
        assert_eq!(
            fs::read_to_string(fixture.root.join("Main.uxml")).unwrap(),
            "crash-original"
        );
        drop(held);
    }

    #[cfg(windows)]
    #[test]
    fn failed_recovery_target_open_names_and_retains_the_relative_backup_artifact() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

        let fixture = Fixture::new();
        let backup_name = ".Main.uxml.uxml-editor-42-13.bak";
        let backup = fixture.root.join(backup_name);
        let target = fixture.root.join("Main.uxml");
        fixture.write(backup_name, "retained-original");
        fixture.write("Main.uxml", "installed-result");
        let held_target = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&target)
            .unwrap();
        let projects = ScopedProjects::default();

        let error = projects.grant_selected(&fixture.root).unwrap_err();

        assert_eq!(error.code, "replace-failed");
        assert!(error.message.contains(backup_name));
        assert!(!error
            .message
            .contains(&fixture.root.to_string_lossy().to_string()));
        assert_eq!(fs::read_to_string(&backup).unwrap(), "retained-original");
        assert_eq!(fs::read_to_string(&target).unwrap(), "installed-result");
        drop(held_target);
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

    #[cfg(unix)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(unix)]
    fn remove_dir_symlink(link: &Path) -> std::io::Result<()> {
        fs::remove_file(link)
    }

    #[cfg(windows)]
    fn remove_dir_symlink(link: &Path) -> std::io::Result<()> {
        fs::remove_dir(link)
    }
}
