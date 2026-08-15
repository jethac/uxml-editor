use crate::error::HostError;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

static REPLACE_LOCK: Mutex<()> = Mutex::new(());
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

pub fn content_revision(path: &Path) -> Result<String, HostError> {
    let mut file = File::open(path).map_err(|error| read_error(path, &error))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| HostError::io("read-failed", "Could not read exact file bytes", &error))?;
    Ok(revision_for_bytes(&bytes))
}

pub fn replace_text_atomically(
    target: &Path,
    expected_revision: &str,
    text: &str,
) -> Result<String, HostError> {
    replace_text_atomically_impl(target, expected_revision, text, None)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
enum FaultPhase {
    AfterTempSync,
    BeforeReplace,
}

#[cfg(test)]
fn replace_text_atomically_with_fault(
    target: &Path,
    expected_revision: &str,
    text: &str,
    fault: FaultPhase,
) -> Result<String, HostError> {
    replace_text_atomically_impl(target, expected_revision, text, Some(fault))
}

fn replace_text_atomically_impl(
    target: &Path,
    expected_revision: &str,
    text: &str,
    #[cfg_attr(not(test), allow(unused_variables))] fault: Option<FaultPhase>,
) -> Result<String, HostError> {
    let _lock = REPLACE_LOCK
        .lock()
        .map_err(|_| HostError::new("replace-failed", "Atomic replacement lock is unavailable."))?;
    let parent = target.parent().ok_or_else(|| {
        HostError::new(
            "invalid-path",
            "Replacement target has no parent directory.",
        )
    })?;
    if !target.is_file() {
        return Err(HostError::new(
            "not-found",
            "Replacement target does not exist.",
        ));
    }
    let (mut temporary, temporary_guard) = create_unique_sibling(target)?;
    temporary.write_all(text.as_bytes()).map_err(|error| {
        HostError::io(
            "replace-failed",
            "Could not write replacement bytes",
            &error,
        )
    })?;
    temporary.sync_all().map_err(|error| {
        HostError::io(
            "replace-failed",
            "Could not flush replacement bytes",
            &error,
        )
    })?;
    drop(temporary);

    #[cfg(test)]
    if fault == Some(FaultPhase::AfterTempSync) {
        return Err(HostError::new(
            "replace-failed",
            "Injected failure after temporary-file flush.",
        ));
    }

    let current_revision = content_revision(target)?;
    if current_revision != expected_revision {
        return Err(HostError::new(
            "stale-revision",
            "File changed before replacement.",
        ));
    }

    #[cfg(test)]
    if fault == Some(FaultPhase::BeforeReplace) {
        return Err(HostError::new(
            "replace-failed",
            "Injected failure before atomic replacement.",
        ));
    }

    replace_existing_file(target, temporary_guard.path())?;
    flush_parent_directory(parent)?;
    let resulting_revision = content_revision(target)?;
    let expected_result = revision_for_bytes(text.as_bytes());
    if resulting_revision != expected_result {
        return Err(HostError::new(
            "replace-failed",
            "Atomic replacement did not preserve the requested exact bytes.",
        ));
    }
    Ok(resulting_revision)
}

fn create_unique_sibling(target: &Path) -> Result<(File, TempGuard), HostError> {
    let parent = target.parent().ok_or_else(|| {
        HostError::new(
            "invalid-path",
            "Replacement target has no parent directory.",
        )
    })?;
    let file_name = target
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
        let path = parent.join(temporary_name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, TempGuard { path })),
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

pub(crate) fn revision_for_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:v1:{digest:x}")
}

fn read_error(path: &Path, error: &std::io::Error) -> HostError {
    let code = if error.kind() == std::io::ErrorKind::NotFound {
        "not-found"
    } else if error.kind() == std::io::ErrorKind::PermissionDenied {
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
    use super::{
        content_revision, replace_text_atomically, replace_text_atomically_with_fault, FaultPhase,
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
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
