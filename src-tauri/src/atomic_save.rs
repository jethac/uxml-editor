use crate::error::HostError;
use cap_std::fs::{Dir, File as CapFile, OpenOptions as CapOpenOptions};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

#[cfg(not(windows))]
use std::fs;
#[cfg(any(test, not(windows)))]
use std::fs::File;

static REPLACE_LOCK: Mutex<()> = Mutex::new(());
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);
static NEXT_BACKUP: AtomicU64 = AtomicU64::new(1);

type QuarantineHook<'a> = Option<&'a mut dyn FnMut(&Path) -> std::io::Result<()>>;
type ResultHook<'a> = Option<&'a mut dyn FnMut(&Path) -> std::io::Result<()>>;

#[cfg(test)]
type QuarantineHookResult = (
    Result<String, HostError>,
    Option<(PathBuf, std::io::Result<()>)>,
);

#[cfg(test)]
pub fn content_revision(path: &Path) -> Result<String, HostError> {
    let mut file = File::open(path).map_err(|error| read_error(path, &error))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| HostError::io("read-failed", "Could not read exact file bytes", &error))?;
    Ok(revision_for_bytes(&bytes))
}

pub fn replace_text_atomically(
    parent: &Dir,
    target_name: &Path,
    expected_revision: &str,
    text: &str,
) -> Result<String, HostError> {
    replace_text_atomically_impl(
        parent,
        target_name,
        expected_revision,
        text,
        ReplacementHooks::default(),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
enum FaultPhase {
    AfterTempSync,
    BeforeReplace,
    BeforeQuarantineOpen,
    BeforeQuarantineRead,
    AfterInstall,
    BeforeResultRead,
    BeforeCleanupFlush,
    BeforeBackupCleanup,
}

#[derive(Default)]
struct ReplacementHooks<'a> {
    fault: Option<FaultPhase>,
    before_commit: Option<&'a mut dyn FnMut() -> std::io::Result<()>>,
    before_quarantine_link: QuarantineHook<'a>,
    during_quarantine: QuarantineHook<'a>,
    after_result_hash: ResultHook<'a>,
}

#[cfg(test)]
fn replace_text_atomically_with_fault(
    parent: &Dir,
    target_name: &Path,
    expected_revision: &str,
    text: &str,
    fault: FaultPhase,
) -> Result<String, HostError> {
    replace_text_atomically_impl(
        parent,
        target_name,
        expected_revision,
        text,
        ReplacementHooks {
            fault: Some(fault),
            ..ReplacementHooks::default()
        },
    )
}

#[cfg(test)]
fn replace_text_atomically_with_commit_hook(
    parent: &Dir,
    target_name: &Path,
    expected_revision: &str,
    text: &str,
    hook: &mut dyn FnMut() -> std::io::Result<()>,
) -> (Result<String, HostError>, Option<std::io::Result<()>>) {
    let mut hook_result = None;
    let mut recording_hook = || {
        let result = hook();
        hook_result = Some(result.as_ref().map(|_| ()).map_err(clone_io_error));
        result
    };
    let result = replace_text_atomically_impl(
        parent,
        target_name,
        expected_revision,
        text,
        ReplacementHooks {
            before_commit: Some(&mut recording_hook),
            ..ReplacementHooks::default()
        },
    );
    (result, hook_result)
}

#[cfg(test)]
fn replace_text_atomically_with_quarantine_hook(
    parent: &Dir,
    target_name: &Path,
    expected_revision: &str,
    text: &str,
    hook: &mut dyn FnMut(&Path) -> std::io::Result<()>,
) -> QuarantineHookResult {
    let mut hook_result = None;
    let mut recording_hook = |path: &Path| {
        let result = hook(path);
        hook_result = Some((
            path.to_path_buf(),
            result.as_ref().map(|_| ()).map_err(clone_io_error),
        ));
        result
    };
    let result = replace_text_atomically_impl(
        parent,
        target_name,
        expected_revision,
        text,
        ReplacementHooks {
            before_quarantine_link: Some(&mut recording_hook),
            ..ReplacementHooks::default()
        },
    );
    (result, hook_result)
}

#[cfg(test)]
fn replace_text_atomically_with_quarantine_interval_hook(
    parent: &Dir,
    target_name: &Path,
    expected_revision: &str,
    text: &str,
    hook: &mut dyn FnMut(&Path) -> std::io::Result<()>,
) -> QuarantineHookResult {
    let mut hook_result = None;
    let mut recording_hook = |path: &Path| {
        let result = hook(path);
        hook_result = Some((
            path.to_path_buf(),
            result.as_ref().map(|_| ()).map_err(clone_io_error),
        ));
        result
    };
    let result = replace_text_atomically_impl(
        parent,
        target_name,
        expected_revision,
        text,
        ReplacementHooks {
            during_quarantine: Some(&mut recording_hook),
            ..ReplacementHooks::default()
        },
    );
    (result, hook_result)
}

#[cfg(test)]
fn replace_text_atomically_with_result_hook(
    parent: &Dir,
    target_name: &Path,
    expected_revision: &str,
    text: &str,
    hook: &mut dyn FnMut(&Path) -> std::io::Result<()>,
) -> QuarantineHookResult {
    let mut hook_result = None;
    let mut recording_hook = |path: &Path| {
        let result = hook(path);
        hook_result = Some((
            path.to_path_buf(),
            result.as_ref().map(|_| ()).map_err(clone_io_error),
        ));
        result
    };
    let result = replace_text_atomically_impl(
        parent,
        target_name,
        expected_revision,
        text,
        ReplacementHooks {
            after_result_hash: Some(&mut recording_hook),
            ..ReplacementHooks::default()
        },
    );
    (result, hook_result)
}

fn replace_text_atomically_impl(
    parent: &Dir,
    target_name: &Path,
    expected_revision: &str,
    text: &str,
    hooks: ReplacementHooks<'_>,
) -> Result<String, HostError> {
    let ReplacementHooks {
        fault,
        before_commit,
        before_quarantine_link,
        during_quarantine,
        after_result_hash,
    } = hooks;
    #[cfg(not(windows))]
    {
        let _ = (
            parent,
            target_name,
            expected_revision,
            text,
            fault,
            before_commit,
            before_quarantine_link,
            during_quarantine,
            after_result_hash,
        );
        return Err(HostError::new(
            "unsupported",
            "Native conditional replacement is unsupported on this platform.",
        ));
    }

    #[cfg(windows)]
    {
        #[cfg(not(test))]
        let _ = (fault, before_commit, after_result_hash);
        let _lock = REPLACE_LOCK.lock().map_err(|_| {
            HostError::new("replace-failed", "Atomic replacement lock is unavailable.")
        })?;
        if target_name.components().count() != 1 || target_name.file_name().is_none() {
            return Err(HostError::new(
                "invalid-path",
                "Replacement target must be one capability-relative file name.",
            ));
        }
        let mut checked_target = open_checked_target(parent, target_name)?;
        let current_revision = content_revision_from_cap_file(&mut checked_target)?;
        if current_revision != expected_revision {
            return Err(HostError::new(
                "stale-revision",
                "File changed before replacement.",
            ));
        }

        let mut temporary_guard = create_unique_cap_sibling(parent, target_name)?;
        temporary_guard
            .file_mut()
            .write_all(text.as_bytes())
            .map_err(|error| {
                HostError::io(
                    "replace-failed",
                    "Could not write replacement bytes",
                    &error,
                )
            })?;
        temporary_guard.file().sync_all().map_err(|error| {
            HostError::io(
                "replace-failed",
                "Could not flush replacement bytes",
                &error,
            )
        })?;

        #[cfg(test)]
        if fault == Some(FaultPhase::AfterTempSync) {
            return Err(HostError::new(
                "replace-failed",
                "Injected failure after temporary-file flush.",
            ));
        }

        let commit_revision = content_revision_from_cap_file(&mut checked_target)?;
        if commit_revision != expected_revision {
            return Err(HostError::new(
                "stale-revision",
                "File changed during atomic replacement.",
            ));
        }

        #[cfg(test)]
        if fault == Some(FaultPhase::BeforeReplace) {
            return Err(HostError::new(
                "replace-failed",
                "Injected failure before atomic replacement.",
            ));
        }

        let mut backup_guard = quarantine_target(
            parent,
            target_name,
            checked_target,
            before_quarantine_link,
            during_quarantine,
        )?;

        #[cfg(test)]
        if fault == Some(FaultPhase::BeforeQuarantineOpen) {
            return Err(restore_original_or_retain(
                parent,
                target_name,
                &mut backup_guard,
                HostError::new("replace-failed", "Injected failure before quarantine open."),
            ));
        }
        #[cfg(test)]
        if fault == Some(FaultPhase::BeforeQuarantineRead) {
            return Err(restore_original_or_retain(
                parent,
                target_name,
                &mut backup_guard,
                HostError::new("replace-failed", "Injected failure before quarantine read."),
            ));
        }
        let quarantined_revision = match content_revision_from_cap_file(backup_guard.file_mut()) {
            Ok(revision) => revision,
            Err(error) => {
                return Err(restore_original_or_retain(
                    parent,
                    target_name,
                    &mut backup_guard,
                    error,
                ));
            }
        };
        if quarantined_revision != expected_revision {
            return Err(restore_original_or_retain(
                parent,
                target_name,
                &mut backup_guard,
                HostError::new(
                    "stale-revision",
                    "File changed in the final replacement interval.",
                ),
            ));
        }

        #[cfg(test)]
        if let Some(hook) = before_commit {
            let _ = hook();
        }

        if let Err(error) = temporary_guard.rename_to(parent, target_name) {
            let conflict = error.kind() == std::io::ErrorKind::AlreadyExists;
            backup_guard.retain();
            return Err(conflict_artifact_error(
                &backup_guard,
                if conflict {
                    HostError::new(
                        "stale-revision",
                        "Another writer installed the destination during replacement.",
                    )
                } else {
                    HostError::io(
                        "replace-failed",
                        "Could not install the capability-relative replacement",
                        &error,
                    )
                },
            ));
        }
        temporary_guard.mark_installed(target_name);
        #[cfg(test)]
        if fault == Some(FaultPhase::AfterInstall) {
            backup_guard.retain();
            return Err(conflict_artifact_error(
                &backup_guard,
                HostError::new(
                    "replace-failed",
                    "Injected failure after replacement installation.",
                ),
            ));
        }
        #[cfg(test)]
        if fault == Some(FaultPhase::BeforeResultRead) {
            backup_guard.retain();
            return Err(conflict_artifact_error(
                &backup_guard,
                HostError::new("replace-failed", "Injected failure before result read."),
            ));
        }
        let resulting_revision = match content_revision_from_cap_file(temporary_guard.file_mut()) {
            Ok(revision) => revision,
            Err(error) => {
                backup_guard.retain();
                return Err(conflict_artifact_error(&backup_guard, error));
            }
        };
        let expected_result = revision_for_bytes(text.as_bytes());
        if resulting_revision != expected_result {
            backup_guard.retain();
            return Err(conflict_artifact_error(
                &backup_guard,
                HostError::new(
                    "replace-failed",
                    "Atomic replacement did not preserve the requested exact bytes.",
                ),
            ));
        }
        #[cfg(test)]
        if let Some(hook) = after_result_hash {
            let _ = hook(backup_guard.path());
        }
        #[cfg(test)]
        if fault == Some(FaultPhase::BeforeCleanupFlush) {
            backup_guard.retain();
            return Err(conflict_artifact_error(
                &backup_guard,
                HostError::new("replace-failed", "Injected failure before cleanup flush."),
            ));
        }
        if let Err(error) = flush_cap_parent_directory(parent) {
            backup_guard.retain();
            return Err(conflict_artifact_error(&backup_guard, error));
        }
        #[cfg(test)]
        if fault == Some(FaultPhase::BeforeBackupCleanup) {
            backup_guard.retain();
            return Err(conflict_artifact_error(
                &backup_guard,
                HostError::new("replace-failed", "Injected failure before backup cleanup."),
            ));
        }
        backup_guard.remove()?;
        Ok(resulting_revision)
    }
}

fn quarantine_target(
    parent: &Dir,
    target_name: &Path,
    checked_target: CapFile,
    #[cfg_attr(not(test), allow(unused_variables))] before_link: QuarantineHook<'_>,
    #[cfg_attr(not(test), allow(unused_variables))] after_link: QuarantineHook<'_>,
) -> Result<CapBackupGuard, HostError> {
    let file_name = target_name
        .file_name()
        .ok_or_else(|| HostError::new("invalid-path", "Replacement target has no file name."))?;
    let mut backup_name = OsString::from(".");
    backup_name.push(file_name);
    backup_name.push(format!(
        ".uxml-editor-{}-{}.bak",
        std::process::id(),
        NEXT_BACKUP.fetch_add(1, Ordering::Relaxed)
    ));
    let path = PathBuf::from(backup_name);
    #[cfg(test)]
    if let Some(hook) = before_link {
        let _ = hook(&path);
    }
    #[cfg(test)]
    if let Some(hook) = after_link {
        let _ = hook(&path);
    }
    rename_cap_file(&checked_target, parent, &path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            HostError::new(
                "replace-failed",
                format!(
                    "A quarantine-name conflict was retained at {}.",
                    path.display()
                ),
            )
        } else {
            HostError::io(
                "replace-failed",
                "Could not rename the checked project file into quarantine",
                &error,
            )
        }
    })?;
    Ok(CapBackupGuard {
        path,
        file: checked_target,
        active: true,
    })
}

fn restore_original_or_retain(
    parent: &Dir,
    target_name: &Path,
    backup: &mut CapBackupGuard,
    failure: HostError,
) -> HostError {
    match backup.rename_to(parent, target_name) {
        Ok(()) => {
            backup.mark_restored(target_name);
            failure
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            backup.retain();
            conflict_artifact_error(backup, failure)
        }
        Err(error) => {
            backup.retain();
            let restore = HostError::io(
                "replace-failed",
                "Could not restore quarantined project bytes; the conflict artifact was retained",
                &error,
            );
            HostError::new(
                restore.code,
                format!(
                    "{} Recovery artifact: {}. Original failure: {}",
                    restore.message,
                    backup.path().display(),
                    failure.message
                ),
            )
        }
    }
}

fn conflict_artifact_error(backup: &CapBackupGuard, failure: HostError) -> HostError {
    HostError::new(
        failure.code,
        format!(
            "{} Original bytes were retained in recovery artifact {}.",
            failure.message,
            backup.path().display()
        ),
    )
}

#[cfg(test)]
fn clone_io_error(error: &std::io::Error) -> std::io::Error {
    if let Some(code) = error.raw_os_error() {
        std::io::Error::from_raw_os_error(code)
    } else {
        std::io::Error::new(error.kind(), error.to_string())
    }
}

fn create_unique_cap_sibling(parent: &Dir, target_name: &Path) -> Result<CapTempGuard, HostError> {
    let file_name = target_name
        .file_name()
        .ok_or_else(|| HostError::new("invalid-path", "Replacement target has no file name."))?;
    for _ in 0..64 {
        let mut temporary_name = OsString::from(".");
        temporary_name.push(file_name);
        temporary_name.push(format!(
            ".uxml-editor-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let path = PathBuf::from(temporary_name);
        let mut options = CapOpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(windows)]
        {
            use cap_std::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                DELETE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ,
            };
            options
                .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE)
                .share_mode(FILE_SHARE_READ);
        }
        match parent.open_with(&path, &options) {
            Ok(file) => {
                return Ok(CapTempGuard {
                    path,
                    file,
                    active: true,
                    installed: false,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(HostError::io(
                    "replace-failed",
                    "Could not create a unique sibling replacement file",
                    &error,
                ));
            }
        }
    }
    Err(HostError::new(
        "replace-failed",
        "Could not allocate a unique sibling replacement file.",
    ))
}

fn open_checked_target(parent: &Dir, target_name: &Path) -> Result<CapFile, HostError> {
    let mut options = CapOpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_GENERIC_READ, FILE_SHARE_READ};
        options
            .access_mode(FILE_GENERIC_READ | DELETE)
            .share_mode(FILE_SHARE_READ);
    }
    parent
        .open_with(target_name, &options)
        .map_err(|error| read_error(target_name, &error))
}

#[cfg(windows)]
fn rename_cap_file(file: &CapFile, parent: &Dir, destination: &Path) -> std::io::Result<()> {
    use std::{mem, os::windows::ffi::OsStrExt, os::windows::io::AsRawHandle, ptr};
    use windows_sys::{
        Wdk::Storage::FileSystem::{
            FileRenameInformation, NtSetInformationFile, FILE_RENAME_INFORMATION,
        },
        Win32::{Foundation::RtlNtStatusToDosError, System::IO::IO_STATUS_BLOCK},
    };

    if destination.components().count() != 1 || destination.file_name().is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "handle rename destination must be one relative file name",
        ));
    }
    let name: Vec<u16> = destination.as_os_str().encode_wide().collect();
    if name.is_empty() || name.contains(&0) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "handle rename destination is malformed",
        ));
    }
    let name_bytes = name
        .len()
        .checked_mul(mem::size_of::<u16>())
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "rename name is too long")
        })?;
    let size = mem::size_of::<FILE_RENAME_INFORMATION>()
        .checked_add(name_bytes)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "rename buffer is too large",
            )
        })?;
    let size_u32 = u32::try_from(size).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "rename buffer is too large",
        )
    })?;
    let mut storage = vec![0_u64; size.div_ceil(mem::size_of::<u64>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    let mut status_block = IO_STATUS_BLOCK::default();
    // SAFETY: `storage` is aligned for FILE_RENAME_INFORMATION and sized through the trailing UTF-16 name.
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = parent.as_raw_handle();
        (*info).FileNameLength = u32::try_from(name_bytes).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "rename name is too long")
        })?;
        ptr::copy_nonoverlapping(name.as_ptr(), (*info).FileName.as_mut_ptr(), name.len());
        let status = NtSetInformationFile(
            file.as_raw_handle(),
            &mut status_block,
            info.cast(),
            size_u32,
            FileRenameInformation,
        );
        if status < 0 {
            return Err(std::io::Error::from_raw_os_error(
                RtlNtStatusToDosError(status) as i32,
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn mark_cap_file_deleted(file: &CapFile) -> std::io::Result<()> {
    use std::{mem, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    };

    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: `disposition` is the exact fixed-size buffer required for FileDispositionInfo.
    let deleted = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&raw const disposition).cast(),
            mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if deleted == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn rename_cap_file(_file: &CapFile, _parent: &Dir, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "handle-relative rename is unavailable",
    ))
}

#[cfg(not(windows))]
fn mark_cap_file_deleted(_file: &CapFile) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "handle-bound deletion is unavailable",
    ))
}

fn content_revision_from_cap_file(file: &mut CapFile) -> Result<String, HostError> {
    file.rewind()
        .map_err(|error| HostError::io("read-failed", "Could not seek project file", &error))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| HostError::io("read-failed", "Could not read exact file bytes", &error))?;
    Ok(revision_for_bytes(&bytes))
}

#[cfg(not(windows))]
fn flush_cap_parent_directory(parent: &Dir) -> Result<(), HostError> {
    parent
        .try_clone()
        .and_then(|directory| directory.into_std_file().sync_all())
        .map_err(|error| {
            HostError::io(
                "replace-failed",
                "Could not flush replacement metadata",
                &error,
            )
        })
}

#[cfg(windows)]
fn flush_cap_parent_directory(_parent: &Dir) -> Result<(), HostError> {
    Ok(())
}

pub(crate) fn revision_for_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:v1:{digest:x}")
}

pub(crate) fn recover_atomic_artifacts(root: &Dir) -> Result<(), HostError> {
    recover_atomic_artifacts_in(root, Path::new(""))
}

fn recover_atomic_artifacts_in(directory: &Dir, prefix: &Path) -> Result<(), HostError> {
    let mut files = Vec::new();
    let mut directories = Vec::new();
    for entry in directory.entries().map_err(|error| {
        HostError::io(
            "replace-failed",
            "Could not inspect atomic-save recovery artifacts",
            &error,
        )
    })? {
        let entry = entry.map_err(|error| {
            HostError::io(
                "replace-failed",
                "Could not inspect an atomic-save recovery entry",
                &error,
            )
        })?;
        let file_type = entry.file_type().map_err(|error| {
            HostError::io(
                "replace-failed",
                "Could not inspect an atomic-save recovery entry type",
                &error,
            )
        })?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            directories.push(entry.file_name());
        } else if file_type.is_file() {
            files.push(entry.file_name());
        }
    }
    files.sort();
    directories.sort();

    for file_name in &files {
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let Some(target_name) = atomic_artifact_target(name, ".bak") else {
            continue;
        };
        recover_backup(directory, prefix, Path::new(name), Path::new(target_name))?;
    }
    for file_name in &files {
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let Some(target_name) = atomic_artifact_target(name, ".tmp") else {
            continue;
        };
        recover_temporary(directory, prefix, Path::new(name), Path::new(target_name))?;
    }
    for directory_name in directories {
        let child = directory.open_dir(&directory_name).map_err(|error| {
            HostError::io(
                "replace-failed",
                "Could not open a project directory during atomic-save recovery",
                &error,
            )
        })?;
        recover_atomic_artifacts_in(&child, &prefix.join(directory_name))?;
    }
    Ok(())
}

fn recover_backup(
    directory: &Dir,
    prefix: &Path,
    backup_name: &Path,
    target_name: &Path,
) -> Result<(), HostError> {
    let artifact = prefix.join(backup_name);

    #[cfg(not(windows))]
    {
        let _ = (directory, target_name);
        return Err(HostError::new(
            "unsupported",
            format!(
                "Atomic-save recovery retained unsupported recovery artifact {}.",
                artifact.display()
            ),
        ));
    }

    #[cfg(windows)]
    match directory.symlink_metadata(target_name) {
        Ok(_) => {
            let backup = open_recovery_identity_file(directory, backup_name).map_err(|error| {
                HostError::new(
                    "replace-failed",
                    format!(
                        "Could not open retained recovery artifact {}: {}",
                        artifact.display(),
                        error.message
                    ),
                )
            })?;
            let target = open_recovery_identity_file(directory, target_name)?;
            if !same_file_identity(&backup, &target)? {
                return Err(HostError::new(
                    "replace-failed",
                    format!(
                        "Atomic-save recovery found both a target and different recovery artifact {}.",
                        artifact.display()
                    ),
                ));
            }
            mark_cap_file_deleted(&backup).map_err(|error| {
                HostError::new(
                    "replace-failed",
                    format!(
                        "Could not clean same-identity recovery artifact {}: {error}",
                        artifact.display()
                    ),
                )
            })?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let backup = open_checked_target(directory, backup_name).map_err(|error| {
                HostError::new(
                    "replace-failed",
                    format!(
                        "Could not open retained recovery artifact {}: {}",
                        artifact.display(),
                        error.message
                    ),
                )
            })?;
            rename_cap_file(&backup, directory, target_name).map_err(|error| {
                HostError::new(
                    "replace-failed",
                    format!(
                        "Could not restore absent target from recovery artifact {}: {error}",
                        artifact.display()
                    ),
                )
            })?;
            Ok(())
        }
        Err(error) => Err(HostError::io(
            "replace-failed",
            "Could not inspect an atomic-save recovery target",
            &error,
        )),
    }
}

fn recover_temporary(
    directory: &Dir,
    prefix: &Path,
    temporary_name: &Path,
    target_name: &Path,
) -> Result<(), HostError> {
    let artifact = prefix.join(temporary_name);
    let _ = (directory, target_name);
    Err(HostError::new(
        "replace-failed",
        format!(
            "Atomic-save recovery retained unauthenticated temporary artifact {}.",
            artifact.display()
        ),
    ))
}

#[cfg(windows)]
fn open_recovery_identity_file(parent: &Dir, name: &Path) -> Result<CapFile, HostError> {
    use cap_std::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_GENERIC_READ, FILE_SHARE_DELETE, FILE_SHARE_READ,
    };

    let mut options = CapOpenOptions::new();
    options
        .read(true)
        .access_mode(FILE_GENERIC_READ | DELETE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE);
    parent
        .open_with(name, &options)
        .map_err(|error| read_error(name, &error))
}

#[cfg(windows)]
fn same_file_identity(left: &CapFile, right: &CapFile) -> Result<bool, HostError> {
    fn identity(file: &CapFile) -> Result<(u32, u64), HostError> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };

        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: `information` is a valid output buffer for the live file handle.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            let error = std::io::Error::last_os_error();
            return Err(HostError::io(
                "replace-failed",
                "Could not inspect recovery file identity",
                &error,
            ));
        }
        Ok((
            information.dwVolumeSerialNumber,
            (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
        ))
    }

    Ok(identity(left)? == identity(right)?)
}

fn atomic_artifact_target<'a>(name: &'a str, suffix: &str) -> Option<&'a str> {
    let body = name.strip_prefix('.')?.strip_suffix(suffix)?;
    let marker = body.rfind(".uxml-editor-")?;
    let target = &body[..marker];
    let sequence = &body[marker + ".uxml-editor-".len()..];
    let mut components = sequence.split('-');
    let process = components.next()?;
    let counter = components.next()?;
    if target.is_empty()
        || process.is_empty()
        || counter.is_empty()
        || components.next().is_some()
        || !process.bytes().all(|value| value.is_ascii_digit())
        || !counter.bytes().all(|value| value.is_ascii_digit())
    {
        return None;
    }
    Some(target)
}

fn read_error(path: &Path, error: &std::io::Error) -> HostError {
    let code = if error.kind() == std::io::ErrorKind::NotFound {
        "not-found"
    } else if error.kind() == std::io::ErrorKind::PermissionDenied
        || cfg!(windows) && error.raw_os_error() == Some(32)
    {
        "permission-denied"
    } else {
        "read-failed"
    };
    let _ = path;
    HostError::io(code, "Could not read the project file", error)
}

#[cfg(windows)]
pub(crate) fn replace_existing_file(target: &Path, temporary: &Path) -> Result<(), HostError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let temporary_wide: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: Both path buffers are NUL-terminated and live for the duration of the call.
    let replaced = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temporary_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced == 0 {
        let error = std::io::Error::last_os_error();
        return Err(HostError::io(
            "replace-failed",
            "Windows could not atomically replace the destination",
            &error,
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn replace_existing_file(target: &Path, temporary: &Path) -> Result<(), HostError> {
    fs::rename(temporary, target).map_err(|error| {
        HostError::io(
            "replace-failed",
            "Could not atomically replace the destination",
            &error,
        )
    })
}

#[cfg(not(windows))]
pub(crate) fn flush_parent_directory(parent: &Path) -> Result<(), HostError> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            HostError::io(
                "replace-failed",
                "Could not flush replacement metadata",
                &error,
            )
        })
}

#[cfg(windows)]
pub(crate) fn flush_parent_directory(_parent: &Path) -> Result<(), HostError> {
    Ok(())
}

struct CapTempGuard {
    path: PathBuf,
    file: CapFile,
    active: bool,
    installed: bool,
}

struct CapBackupGuard {
    path: PathBuf,
    file: CapFile,
    active: bool,
}

impl CapBackupGuard {
    fn path(&self) -> &Path {
        &self.path
    }

    fn file_mut(&mut self) -> &mut CapFile {
        &mut self.file
    }

    fn rename_to(&mut self, parent: &Dir, destination: &Path) -> std::io::Result<()> {
        rename_cap_file(&self.file, parent, destination)
    }

    fn mark_restored(&mut self, target_name: &Path) {
        self.path = target_name.to_path_buf();
        self.active = false;
    }

    fn remove(&mut self) -> Result<(), HostError> {
        if !self.active {
            return Ok(());
        }
        mark_cap_file_deleted(&self.file).map_err(|error| {
            HostError::new(
                "replace-failed",
                format!(
                    "Could not clean retained recovery artifact {}: {error}",
                    self.path.display()
                ),
            )
        })?;
        self.active = false;
        Ok(())
    }

    fn retain(&mut self) {
        self.active = false;
    }
}

impl Drop for CapBackupGuard {
    fn drop(&mut self) {}
}

impl CapTempGuard {
    fn file(&self) -> &CapFile {
        &self.file
    }

    fn file_mut(&mut self) -> &mut CapFile {
        &mut self.file
    }

    fn rename_to(&self, parent: &Dir, destination: &Path) -> std::io::Result<()> {
        rename_cap_file(&self.file, parent, destination)
    }

    fn mark_installed(&mut self, target_name: &Path) {
        self.path = target_name.to_path_buf();
        self.active = false;
        self.installed = true;
    }
}

impl Drop for CapTempGuard {
    fn drop(&mut self) {
        if self.active && !self.installed {
            let _ = mark_cap_file_deleted(&self.file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        content_revision, replace_text_atomically as replace_capability_file,
        replace_text_atomically_with_commit_hook as replace_capability_file_with_commit_hook,
        replace_text_atomically_with_fault as replace_capability_file_with_fault,
        replace_text_atomically_with_quarantine_hook as replace_capability_file_with_quarantine_hook,
        replace_text_atomically_with_quarantine_interval_hook as replace_capability_file_with_quarantine_interval_hook,
        replace_text_atomically_with_result_hook as replace_capability_file_with_result_hook,
        FaultPhase, QuarantineHookResult,
    };
    use cap_std::{ambient_authority, fs::Dir};
    use std::{
        fs,
        io::{Seek, SeekFrom, Write},
        path::PathBuf,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, Barrier,
        },
    };

    static NEXT_DIR: AtomicU64 = AtomicU64::new(1);

    fn replace_text_atomically(
        target: &std::path::Path,
        expected_revision: &str,
        text: &str,
    ) -> Result<String, crate::error::HostError> {
        let parent = Dir::open_ambient_dir(target.parent().unwrap(), ambient_authority()).unwrap();
        replace_capability_file(
            &parent,
            std::path::Path::new(target.file_name().unwrap()),
            expected_revision,
            text,
        )
    }

    fn replace_text_atomically_with_fault(
        target: &std::path::Path,
        expected_revision: &str,
        text: &str,
        fault: FaultPhase,
    ) -> Result<String, crate::error::HostError> {
        let parent = Dir::open_ambient_dir(target.parent().unwrap(), ambient_authority()).unwrap();
        replace_capability_file_with_fault(
            &parent,
            std::path::Path::new(target.file_name().unwrap()),
            expected_revision,
            text,
            fault,
        )
    }

    fn replace_text_atomically_with_commit_hook(
        target: &std::path::Path,
        expected_revision: &str,
        text: &str,
        hook: &mut dyn FnMut() -> std::io::Result<()>,
    ) -> (
        Result<String, crate::error::HostError>,
        Option<std::io::Result<()>>,
    ) {
        let parent = Dir::open_ambient_dir(target.parent().unwrap(), ambient_authority()).unwrap();
        replace_capability_file_with_commit_hook(
            &parent,
            std::path::Path::new(target.file_name().unwrap()),
            expected_revision,
            text,
            hook,
        )
    }

    fn replace_text_atomically_with_quarantine_hook(
        target: &std::path::Path,
        expected_revision: &str,
        text: &str,
        hook: &mut dyn FnMut(&std::path::Path) -> std::io::Result<()>,
    ) -> QuarantineHookResult {
        let parent = Dir::open_ambient_dir(target.parent().unwrap(), ambient_authority()).unwrap();
        replace_capability_file_with_quarantine_hook(
            &parent,
            std::path::Path::new(target.file_name().unwrap()),
            expected_revision,
            text,
            hook,
        )
    }

    fn replace_text_atomically_with_quarantine_interval_hook(
        target: &std::path::Path,
        expected_revision: &str,
        text: &str,
        hook: &mut dyn FnMut(&std::path::Path) -> std::io::Result<()>,
    ) -> QuarantineHookResult {
        let parent = Dir::open_ambient_dir(target.parent().unwrap(), ambient_authority()).unwrap();
        replace_capability_file_with_quarantine_interval_hook(
            &parent,
            std::path::Path::new(target.file_name().unwrap()),
            expected_revision,
            text,
            hook,
        )
    }

    fn replace_text_atomically_with_result_hook(
        target: &std::path::Path,
        expected_revision: &str,
        text: &str,
        hook: &mut dyn FnMut(&std::path::Path) -> std::io::Result<()>,
    ) -> QuarantineHookResult {
        let parent = Dir::open_ambient_dir(target.parent().unwrap(), ambient_authority()).unwrap();
        replace_capability_file_with_result_hook(
            &parent,
            std::path::Path::new(target.file_name().unwrap()),
            expected_revision,
            text,
            hook,
        )
    }

    #[test]
    fn replaces_existing_file_with_exact_crlf_and_unicode_bytes() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"<UXML />\r\n");
        let original = content_revision(&target).unwrap();

        let revision =
            replace_text_atomically(&target, &original, "<UXML label=\"日本語\">\r\n</UXML>\r\n")
                .unwrap();

        assert_eq!(
            fs::read(&target).unwrap(),
            "<UXML label=\"日本語\">\r\n</UXML>\r\n".as_bytes()
        );
        assert_eq!(revision, content_revision(&target).unwrap());
        assert_ne!(revision, original);
        fixture.assert_no_artifacts();
    }

    #[test]
    fn rejects_stale_and_concurrent_replacements_without_touching_the_winner() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"original");
        let observed = content_revision(&target).unwrap();

        let winner = replace_text_atomically(&target, &observed, "winner").unwrap();
        let error = replace_text_atomically(&target, &observed, "loser").unwrap_err();

        assert_eq!(error.code, "stale-revision");
        assert_eq!(fs::read(&target).unwrap(), b"winner");
        assert_eq!(content_revision(&target).unwrap(), winner);
        fixture.assert_no_artifacts();
    }

    #[test]
    fn serializes_two_writers_observing_the_same_revision_so_only_one_commits() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"original");
        let observed = content_revision(&target).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let workers: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|text| {
                let target = target.clone();
                let observed = observed.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    replace_text_atomically(&target, &observed, text)
                })
            })
            .collect();

        barrier.wait();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .filter(|error| error.code == "stale-revision")
                .count(),
            1
        );
        let bytes = fs::read(&target).unwrap();
        assert!(bytes == b"first" || bytes == b"second");
        fixture.assert_no_artifacts();
    }

    #[test]
    fn external_writer_in_the_check_to_commit_interval_is_prevented_or_preserved() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"original");
        let observed = content_revision(&target).unwrap();
        let mut external_write = || fs::write(&target, b"external-writer");

        let (replacement, external) = replace_text_atomically_with_commit_hook(
            &target,
            &observed,
            "editor-replacement",
            &mut external_write,
        );

        let external = external.unwrap();
        #[cfg(not(windows))]
        assert!(
            external.is_ok(),
            "non-Windows replacement does not deny an external writer"
        );
        if external.is_ok() {
            let error = replacement.unwrap_err();
            assert_eq!(error.code, "stale-revision");
            assert!(error.message.contains("recovery artifact"));
            assert_eq!(fs::read(&target).unwrap(), b"external-writer");
            assert!(fixture.has_recoverable_bytes("Main.uxml", b"original"));
        } else {
            replacement.unwrap();
            assert_eq!(fs::read(&target).unwrap(), b"editor-replacement");
            fixture.assert_no_artifacts();
        }
    }

    #[test]
    fn external_path_replacement_in_the_final_commit_interval_is_never_overwritten() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"original");
        let displaced = fixture.root.join("displaced-original.uxml");
        let observed = content_revision(&target).unwrap();
        let mut external_replace = || {
            if target.exists() {
                fs::rename(&target, &displaced)?;
            }
            fs::write(&target, b"external-final-writer")
        };

        let (replacement, external) = replace_text_atomically_with_commit_hook(
            &target,
            &observed,
            "editor-replacement",
            &mut external_replace,
        );

        external.unwrap().unwrap();
        assert!(
            replacement.is_err(),
            "the editor committed over an external path entry"
        );
        assert_eq!(fs::read(&target).unwrap(), b"external-final-writer");
        assert!(
            fixture.has_recoverable_bytes("Main.uxml", b"original"),
            "the admitted destination race discarded the original bytes"
        );
    }

    #[cfg(windows)]
    #[test]
    fn competitor_replacement_during_target_quarantine_is_preserved_or_excluded() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"original");
        let displaced = fixture.root.join("displaced-original.uxml");
        let observed = content_revision(&target).unwrap();
        let competitor = || {
            fs::rename(&target, &displaced)?;
            fs::write(&target, b"external-quarantine-writer")
        };

        let (replacement, hook) = replace_text_atomically_with_quarantine_interval_hook(
            &target,
            &observed,
            "editor-replacement",
            &mut |_| competitor(),
        );

        let (_, hook_result) = hook.expect("quarantine interval hook did not run");
        if hook_result.is_ok() {
            assert!(
                replacement.is_err(),
                "editor committed after deleting a competitor path"
            );
            assert_eq!(fs::read(&target).unwrap(), b"external-quarantine-writer");
        } else {
            replacement.unwrap();
            assert_eq!(fs::read(&target).unwrap(), b"editor-replacement");
        }
    }

    #[cfg(windows)]
    #[test]
    fn competitor_replacement_after_result_hash_cannot_produce_false_success() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"original");
        let displaced = fixture.root.join("displaced-editor-result.uxml");
        let observed = content_revision(&target).unwrap();
        let mut competitor = |_: &std::path::Path| {
            fs::rename(&target, &displaced)?;
            fs::write(&target, b"external-after-result-hash")
        };

        let (replacement, hook) = replace_text_atomically_with_result_hook(
            &target,
            &observed,
            "editor-replacement",
            &mut competitor,
        );

        let (_, hook_result) = hook.expect("result interval hook did not run");
        if hook_result.is_ok() {
            assert!(
                replacement.is_err(),
                "replacement returned success for a competitor destination"
            );
            assert_eq!(fs::read(&target).unwrap(), b"external-after-result-hash");
        } else {
            replacement.unwrap();
            assert_eq!(fs::read(&target).unwrap(), b"editor-replacement");
        }
    }

    #[cfg(windows)]
    #[test]
    fn writer_cannot_mutate_the_quarantined_original_after_its_final_hash() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"original");
        let observed = content_revision(&target).unwrap();
        let root = fixture.root.clone();
        let mut mutate_backup = || {
            let backup = fs::read_dir(&root)?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|path| {
                    path.file_name().is_some_and(|name| {
                        name.to_string_lossy().contains(".uxml-editor-")
                            && name.to_string_lossy().ends_with(".bak")
                    })
                })
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "backup"))?;
            fs::write(backup, b"external-after-quarantine-hash")
        };

        let (replacement, hook) = replace_text_atomically_with_commit_hook(
            &target,
            &observed,
            "editor-replacement",
            &mut mutate_backup,
        );

        assert!(hook.expect("final hash hook did not run").is_err());
        replacement.unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"editor-replacement");
        fixture.assert_no_artifacts();
    }

    #[cfg(windows)]
    #[test]
    fn final_backup_cleanup_failure_names_the_retained_relative_artifact() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"original");
        let observed = content_revision(&target).unwrap();
        let error = replace_text_atomically_with_fault(
            &target,
            &observed,
            "editor-replacement",
            FaultPhase::BeforeBackupCleanup,
        )
        .unwrap_err();

        assert!(error.message.contains(".Main.uxml.uxml-editor-"));
        assert!(error.message.contains(".bak"));
        assert!(!error
            .message
            .contains(&fixture.root.to_string_lossy().to_string()));
        assert_eq!(fs::read(&target).unwrap(), b"editor-replacement");
        assert!(fixture.has_recoverable_bytes("Main.uxml", b"original"));
    }

    #[test]
    fn a_raced_quarantine_name_is_never_overwritten() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"original");
        let observed = content_revision(&target).unwrap();
        let root = fixture.root.clone();
        let mut raced = false;
        let mut create_external = |relative: &std::path::Path| {
            if !raced {
                raced = true;
                fs::write(root.join(relative), b"external-backup-entry")?;
            }
            Ok(())
        };

        let (replacement, hook) = replace_text_atomically_with_quarantine_hook(
            &target,
            &observed,
            "editor-replacement",
            &mut create_external,
        );

        let (relative, hook_result) = hook.expect("quarantine race hook did not run");
        hook_result.unwrap();
        assert_eq!(
            fs::read(fixture.root.join(relative)).unwrap(),
            b"external-backup-entry",
            "the editor overwrote an external quarantine-name entry"
        );
        assert!(replacement.is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
    }

    #[test]
    fn existing_external_writer_is_excluded_or_its_bytes_are_restored() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"original");
        let observed = content_revision(&target).unwrap();
        let mut writer = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&target)
            .unwrap();
        let mut external_write = || {
            writer.seek(SeekFrom::Start(0))?;
            writer.write_all(b"external-existing")?;
            writer.set_len(b"external-existing".len() as u64)?;
            writer.sync_all()
        };

        let (replacement, hook) = replace_text_atomically_with_commit_hook(
            &target,
            &observed,
            "editor-replacement",
            &mut external_write,
        );

        #[cfg(windows)]
        {
            assert!(
                hook.is_none(),
                "the final hook ran despite an admitted writable handle"
            );
            assert_eq!(replacement.unwrap_err().code, "permission-denied");
            external_write().unwrap();
            assert_eq!(fs::read(&target).unwrap(), b"external-existing");
        }
        #[cfg(not(windows))]
        {
            hook.unwrap().unwrap();
            assert!(replacement.is_err());
            assert_eq!(fs::read(&target).unwrap(), b"external-existing");
        }
        fixture.assert_no_artifacts();
    }

    #[test]
    fn every_post_quarantine_failure_retains_the_original_bytes_for_recovery() {
        for phase in [
            FaultPhase::BeforeQuarantineOpen,
            FaultPhase::BeforeQuarantineRead,
            FaultPhase::AfterInstall,
            FaultPhase::BeforeResultRead,
            FaultPhase::BeforeCleanupFlush,
        ] {
            let fixture = Fixture::new();
            let target = fixture.write("Main.uxml", b"original-post-quarantine");
            let observed = content_revision(&target).unwrap();

            let error =
                replace_text_atomically_with_fault(&target, &observed, "editor-replacement", phase)
                    .unwrap_err();

            assert_eq!(error.code, "replace-failed", "phase: {phase:?}");
            assert!(
                fixture.has_recoverable_bytes("Main.uxml", b"original-post-quarantine"),
                "phase {phase:?} silently discarded the original bytes"
            );
        }
    }

    #[test]
    fn cleans_unique_sibling_temp_and_preserves_original_at_each_precommit_failure() {
        for phase in [FaultPhase::AfterTempSync, FaultPhase::BeforeReplace] {
            let fixture = Fixture::new();
            let target = fixture.write("Main.uxml", b"original\r\n");
            let observed = content_revision(&target).unwrap();

            let error =
                replace_text_atomically_with_fault(&target, &observed, "replacement", phase)
                    .unwrap_err();

            assert_eq!(error.code, "replace-failed");
            assert_eq!(fs::read(&target).unwrap(), b"original\r\n");
            assert_eq!(content_revision(&target).unwrap(), observed);
            fixture.assert_no_artifacts();
        }
    }

    #[cfg(windows)]
    #[test]
    fn uses_windows_replace_semantics_for_an_existing_destination() {
        let fixture = Fixture::new();
        let target = fixture.write("Main.uxml", b"old");
        let observed = content_revision(&target).unwrap();

        replace_text_atomically(&target, &observed, "new").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        fixture.assert_no_artifacts();
    }

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "uxml-editor-atomic-test-{}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.root.join(name);
            fs::write(&path, bytes).unwrap();
            path
        }

        fn assert_no_artifacts(&self) {
            let artifacts: Vec<_> = fs::read_dir(&self.root)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| name.contains(".uxml-editor-"))
                .collect();
            assert!(artifacts.is_empty(), "leftover artifacts: {artifacts:?}");
        }

        fn has_recoverable_bytes(&self, target_name: &str, expected: &[u8]) -> bool {
            fs::read(self.root.join(target_name)).is_ok_and(|bytes| bytes == expected)
                || fs::read_dir(&self.root).unwrap().any(|entry| {
                    let path = entry.unwrap().path();
                    path.file_name()
                        .is_some_and(|name| name.to_string_lossy().contains(".uxml-editor-"))
                        && fs::read(path).is_ok_and(|bytes| bytes == expected)
                })
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
