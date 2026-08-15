mod app_data;
mod atomic_save;
mod commands;
mod desktop;
mod error;
mod scoped_fs;
mod watch;

use commands::{
    ConfirmationDto, ConfirmationRequest, FileEnumerationDto, HostState, MessageKind,
    MessageRequest, PathRequest, ProjectRequest, RecentProjectRequest, RecoveryDto,
    RecoveryWriteRequest, ReplaceTextRequest, RevisionDto, WatchStartDto, WatchStopRequest,
};
use desktop::MenuCommandPayload;
use error::HostError;
use scoped_fs::{ProjectRootDto, ReadTextDto};
use std::{sync::Arc, time::SystemTime};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use watch::WatchEmitter;

#[tauri::command]
async fn host_choose_project(
    app: AppHandle,
    state: State<'_, HostState>,
) -> Result<Option<ProjectRootDto>, HostError> {
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("Choose UXML project")
            .blocking_pick_folder()
    })
    .await
    .map_err(|error| {
        HostError::new(
            "selection-failed",
            format!("Project directory picker failed: {error}"),
        )
    })?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| {
        HostError::new(
            "selection-failed",
            format!("Selected project directory is not a filesystem path: {error}"),
        )
    })?;
    state.select_project(&path).map(Some)
}

#[tauri::command]
fn host_enumerate_files(
    state: State<'_, HostState>,
    request: ProjectRequest,
) -> Result<FileEnumerationDto, HostError> {
    state.enumerate(&request)
}

#[tauri::command]
fn host_read_text(
    state: State<'_, HostState>,
    request: PathRequest,
) -> Result<ReadTextDto, HostError> {
    state.read(&request)
}

#[tauri::command]
fn host_replace_text(
    state: State<'_, HostState>,
    request: ReplaceTextRequest,
) -> Result<RevisionDto, HostError> {
    state.replace(&request)
}

#[tauri::command]
fn host_start_watch(
    app: AppHandle,
    state: State<'_, HostState>,
    request: ProjectRequest,
) -> Result<WatchStartDto, HostError> {
    let event_app = app.clone();
    let emit: WatchEmitter = Arc::new(move |event| {
        let _ = event_app.emit("uxml://file-change", event);
    });
    state.start_watch(&request, emit)
}

#[tauri::command]
fn host_stop_watch(
    state: State<'_, HostState>,
    request: WatchStopRequest,
) -> Result<(), HostError> {
    state.watches.stop(&request.watch_id)
}

#[tauri::command]
fn host_read_recovery(
    state: State<'_, HostState>,
    request: ProjectRequest,
) -> Result<RecoveryDto, HostError> {
    state.read_recovery(&request)
}

#[tauri::command]
fn host_write_recovery(
    state: State<'_, HostState>,
    request: RecoveryWriteRequest,
) -> Result<(), HostError> {
    state.write_recovery(&request)
}

#[tauri::command]
fn host_clear_recovery(
    state: State<'_, HostState>,
    request: ProjectRequest,
) -> Result<(), HostError> {
    state.clear_recovery(&request)
}

#[tauri::command]
fn host_list_recent_projects(
    state: State<'_, HostState>,
) -> Result<Vec<app_data::RecentProjectDto>, HostError> {
    state.list_recent()
}

#[tauri::command]
fn host_remember_recent_project(
    state: State<'_, HostState>,
    request: RecentProjectRequest,
) -> Result<(), HostError> {
    let elapsed = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|error| {
            HostError::new(
                "app-data-failed",
                format!("System clock is before the Unix epoch: {error}"),
            )
        })?;
    let milliseconds = u64::try_from(elapsed.as_millis()).map_err(|_| {
        HostError::new(
            "app-data-failed",
            "System clock is outside the supported timestamp range.",
        )
    })?;
    state.remember_recent(&request, milliseconds)
}

#[tauri::command]
async fn host_confirm(
    app: AppHandle,
    request: ConfirmationRequest,
) -> Result<ConfirmationDto, HostError> {
    validate_dialog_text(&request.title, "title", 512)?;
    validate_dialog_text(&request.message, "message", 16_384)?;
    validate_dialog_text(&request.confirm_label, "confirm label", 128)?;
    validate_dialog_text(&request.cancel_label, "cancel label", 128)?;
    let _kind = request.kind;
    let confirm_label = request.confirm_label.clone();
    let dialog_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .message(request.message)
            .title(request.title)
            .buttons(MessageDialogButtons::OkCancelCustom(
                request.confirm_label,
                request.cancel_label,
            ))
            .blocking_show_with_result()
    })
    .await
    .map_err(dialog_task_error)?;
    Ok(ConfirmationDto {
        confirmed: desktop::confirmation_result(result, &confirm_label),
    })
}

#[tauri::command]
async fn host_show_message(app: AppHandle, request: MessageRequest) -> Result<(), HostError> {
    validate_dialog_text(&request.title, "title", 512)?;
    validate_dialog_text(&request.message, "message", 16_384)?;
    let kind = match request.kind {
        MessageKind::Info => MessageDialogKind::Info,
        MessageKind::Warning => MessageDialogKind::Warning,
        MessageKind::Error => MessageDialogKind::Error,
    };
    let dialog_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .message(request.message)
            .title(request.title)
            .kind(kind)
            .buttons(MessageDialogButtons::Ok)
            .blocking_show_with_result()
    })
    .await
    .map_err(dialog_task_error)?;
    Ok(())
}

#[tauri::command]
async fn desktop_confirm_close(app: AppHandle) -> Result<&'static str, HostError> {
    let dialog_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .message("Save changes before closing?")
            .title("Unsaved changes")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                "Save".to_string(),
                "Discard".to_string(),
                "Cancel".to_string(),
            ))
            .blocking_show_with_result()
    })
    .await
    .map_err(dialog_task_error)?;
    Ok(desktop::close_choice(result))
}

#[tauri::command]
fn desktop_authorize_close(state: State<'_, HostState>) {
    state.close_gate.authorize_once();
}

#[tauri::command]
fn desktop_revoke_close_authorization(state: State<'_, HostState>) {
    state.close_gate.revoke_authorization();
}

fn validate_dialog_text(value: &str, field: &str, max_length: usize) -> Result<(), HostError> {
    if value.trim().is_empty() || value.len() > max_length {
        return Err(HostError::new(
            "dialog-failed",
            format!("Dialog {field} is empty or too long."),
        ));
    }
    Ok(())
}

fn dialog_task_error(error: impl std::fmt::Display) -> HostError {
    HostError::new(
        "dialog-failed",
        format!("Native dialog task failed: {error}"),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(desktop::build_menu)
        .on_menu_event(|app, event| {
            let command_id = event.id().0.as_str();
            if desktop::is_desktop_command(command_id) {
                let _ = app.emit(
                    "uxml://menu-command",
                    MenuCommandPayload {
                        command_id: command_id.to_string(),
                    },
                );
            }
        })
        .setup(|app| {
            let app_data_root = app.path().app_data_dir()?;
            if !app.manage(HostState::new(app_data_root)) {
                return Err(
                    std::io::Error::other("Desktop host state was already managed.").into(),
                );
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_choose_project,
            host_enumerate_files,
            host_read_text,
            host_replace_text,
            host_start_watch,
            host_stop_watch,
            host_read_recovery,
            host_write_recovery,
            host_clear_recovery,
            host_list_recent_projects,
            host_remember_recent_project,
            host_confirm,
            host_show_message,
            desktop_confirm_close,
            desktop_authorize_close,
            desktop_revoke_close_authorization,
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let Some(state) = window.try_state::<HostState>() else {
                    api.prevent_close();
                    return;
                };
                if state.close_gate.should_intercept() {
                    api.prevent_close();
                    let _ = window.emit("uxml://close-requested", ());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
