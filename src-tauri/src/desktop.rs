use crate::{error::HostError, identifiers::deserialize_close_lease};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, Submenu, SubmenuBuilder},
    AppHandle, Runtime,
};
use tauri_plugin_dialog::MessageDialogResult;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuSection {
    File,
    Edit,
    View,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MenuCommandSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub accelerator: Option<&'static str>,
    pub section: MenuSection,
    pub enabled_by_default: bool,
}

pub const MENU_COMMANDS: &[MenuCommandSpec] = &[
    MenuCommandSpec {
        id: "file.open-project",
        label: "Open Project...",
        accelerator: Some("Ctrl+O"),
        section: MenuSection::File,
        enabled_by_default: true,
    },
    MenuCommandSpec {
        id: "file.save",
        label: "Save",
        accelerator: Some("Ctrl+S"),
        section: MenuSection::File,
        enabled_by_default: false,
    },
    MenuCommandSpec {
        id: "file.save-all",
        label: "Save All",
        accelerator: Some("Ctrl+Shift+S"),
        section: MenuSection::File,
        enabled_by_default: false,
    },
    MenuCommandSpec {
        id: "file.close-project",
        label: "Close Project",
        accelerator: Some("Ctrl+Shift+W"),
        section: MenuSection::File,
        enabled_by_default: false,
    },
    MenuCommandSpec {
        id: "edit.undo",
        label: "Undo",
        accelerator: Some("Ctrl+Z"),
        section: MenuSection::Edit,
        enabled_by_default: true,
    },
    MenuCommandSpec {
        id: "edit.redo",
        label: "Redo",
        accelerator: Some("Ctrl+Y"),
        section: MenuSection::Edit,
        enabled_by_default: true,
    },
    MenuCommandSpec {
        id: "view.zoom-in",
        label: "Zoom In",
        accelerator: Some("Ctrl+="),
        section: MenuSection::View,
        enabled_by_default: true,
    },
    MenuCommandSpec {
        id: "view.zoom-out",
        label: "Zoom Out",
        accelerator: Some("Ctrl+-"),
        section: MenuSection::View,
        enabled_by_default: true,
    },
    MenuCommandSpec {
        id: "view.pane-hierarchy",
        label: "Hierarchy Pane",
        accelerator: Some("Ctrl+Alt+1"),
        section: MenuSection::View,
        enabled_by_default: true,
    },
    MenuCommandSpec {
        id: "view.pane-inspector",
        label: "Inspector Pane",
        accelerator: Some("Ctrl+Alt+2"),
        section: MenuSection::View,
        enabled_by_default: true,
    },
    MenuCommandSpec {
        id: "view.pane-diagnostics",
        label: "Diagnostics Pane",
        accelerator: Some("Ctrl+Alt+3"),
        section: MenuSection::View,
        enabled_by_default: true,
    },
    MenuCommandSpec {
        id: "view.pane-source",
        label: "Source Pane",
        accelerator: Some("Ctrl+Alt+4"),
        section: MenuSection::View,
        enabled_by_default: true,
    },
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuCommandPayload {
    pub command_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileWorkflowEnabledRequest {
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CloseResolution {
    Close,
    Cancel,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseResolutionRequest {
    #[serde(deserialize_with = "deserialize_close_lease")]
    pub lease: String,
    pub action: CloseResolution,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseRequestPayload {
    pub lease: String,
}

pub fn is_desktop_command(id: &str) -> bool {
    MENU_COMMANDS.iter().any(|command| command.id == id)
}

#[derive(Default)]
pub struct CloseGate {
    state: Mutex<CloseState>,
    next_lease: AtomicU64,
}

#[derive(Default)]
struct CloseState {
    pending: Option<String>,
}

impl CloseGate {
    pub fn request(&self) -> Result<CloseGateDecision, HostError> {
        let mut state = self.lock()?;
        if state.pending.is_some() {
            return Ok(CloseGateDecision::Prevent);
        }
        let lease = format!(
            "close:v1:{:016x}",
            self.next_lease.fetch_add(1, Ordering::Relaxed)
        );
        state.pending = Some(lease.clone());
        Ok(CloseGateDecision::Emit(lease))
    }

    pub fn resolve(&self, lease: &str, resolution: CloseResolution) -> Result<bool, HostError> {
        let mut state = self.lock()?;
        if state.pending.as_deref() != Some(lease) {
            return Err(HostError::new(
                "read-failed",
                "Desktop close lease is not current.",
            ));
        }
        state.pending = None;
        Ok(resolution == CloseResolution::Close)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, CloseState>, HostError> {
        self.state
            .lock()
            .map_err(|_| HostError::new("read-failed", "Desktop close state is unavailable."))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloseGateDecision {
    Prevent,
    Emit(String),
}

pub fn close_choice(result: MessageDialogResult) -> &'static str {
    match result {
        MessageDialogResult::Yes => "save",
        MessageDialogResult::No => "discard",
        MessageDialogResult::Custom(label) if label == "Save" => "save",
        MessageDialogResult::Custom(label) if label == "Discard" => "discard",
        MessageDialogResult::Ok | MessageDialogResult::Cancel | MessageDialogResult::Custom(_) => {
            "cancel"
        }
    }
}

pub fn confirmation_result(result: MessageDialogResult, confirm_label: &str) -> bool {
    match result {
        MessageDialogResult::Ok | MessageDialogResult::Yes => true,
        MessageDialogResult::Custom(label) => label == confirm_label,
        MessageDialogResult::No | MessageDialogResult::Cancel => false,
    }
}

pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let file = build_submenu(app, "File", MenuSection::File)?;
    let edit = build_submenu(app, "Edit", MenuSection::Edit)?;
    let view = build_submenu(app, "View", MenuSection::View)?;
    MenuBuilder::new(app).items(&[&file, &edit, &view]).build()
}

pub fn set_file_workflow_enabled<R: Runtime>(menu: &Menu<R>, enabled: bool) -> tauri::Result<()> {
    let mut updated = 0;
    for item in menu.items()? {
        let Some(submenu) = item.as_submenu() else {
            continue;
        };
        for id in ["file.save", "file.save-all", "file.close-project"] {
            if let Some(item) = submenu.get(id).and_then(|item| item.as_menuitem().cloned()) {
                item.set_enabled(enabled)?;
                updated += 1;
            }
        }
    }
    if updated == 3 {
        Ok(())
    } else {
        Err(tauri::Error::AssetNotFound(
            "native file-workflow menu items".to_string(),
        ))
    }
}

fn build_submenu<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    section: MenuSection,
) -> tauri::Result<Submenu<R>> {
    let mut builder = SubmenuBuilder::new(app, title);
    for command in MENU_COMMANDS.iter().filter(|item| item.section == section) {
        let mut item = MenuItemBuilder::with_id(command.id, command.label);
        item = item.enabled(command.enabled_by_default);
        if let Some(accelerator) = command.accelerator {
            item = item.accelerator(accelerator);
        }
        let item = item.build(app)?;
        builder = builder.item(&item);
    }
    builder.build()
}

#[cfg(test)]
mod tests {
    use super::{
        close_choice, is_desktop_command, CloseGate, CloseGateDecision, CloseResolution,
        CloseResolutionRequest, MenuSection, MENU_COMMANDS,
    };
    use tauri_plugin_dialog::MessageDialogResult;

    #[test]
    fn menu_ids_exactly_match_the_typed_frontend_bridge() {
        let actual: Vec<_> = MENU_COMMANDS.iter().map(|item| item.id).collect();
        assert_eq!(
            actual,
            [
                "file.open-project",
                "file.save",
                "file.save-all",
                "file.close-project",
                "edit.undo",
                "edit.redo",
                "view.zoom-in",
                "view.zoom-out",
                "view.pane-hierarchy",
                "view.pane-inspector",
                "view.pane-diagnostics",
                "view.pane-source",
            ]
        );
        assert_eq!(
            MENU_COMMANDS
                .iter()
                .filter(|item| item.section == MenuSection::File)
                .count(),
            4
        );
        assert!(MENU_COMMANDS
            .iter()
            .all(|item| !item.label.is_empty() && item.accelerator.is_some()));
    }

    #[test]
    fn tauri_config_explicitly_labels_the_capability_scoped_window() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();

        assert_eq!(
            config.pointer("/app/windows/0/label"),
            Some(&serde_json::json!("main"))
        );
    }

    #[test]
    fn menu_event_allowlist_rejects_unknown_ids() {
        assert!(is_desktop_command("file.open-project"));
        assert!(is_desktop_command("view.pane-source"));
        assert!(!is_desktop_command("shell.execute"));
        assert!(!is_desktop_command(""));
    }

    #[test]
    fn file_workflow_items_are_disabled_until_task_16_binds_ownership() {
        for id in ["file.save", "file.save-all", "file.close-project"] {
            let command = MENU_COMMANDS
                .iter()
                .find(|command| command.id == id)
                .unwrap();
            assert!(!command.enabled_by_default, "{id} must start disabled");
        }
        assert!(
            MENU_COMMANDS
                .iter()
                .find(|command| command.id == "file.open-project")
                .unwrap()
                .enabled_by_default
        );
    }

    #[test]
    fn close_lease_is_single_use_and_duplicate_native_requests_are_coalesced() {
        let gate = CloseGate::default();
        let CloseGateDecision::Emit(lease) = gate.request().unwrap() else {
            panic!("first request must emit");
        };
        assert_eq!(gate.request().unwrap(), CloseGateDecision::Prevent);
        assert!(gate.resolve(&lease, CloseResolution::Close).unwrap());
        assert!(matches!(
            gate.request().unwrap(),
            CloseGateDecision::Emit(_)
        ));
    }

    #[test]
    fn cancelled_failed_and_stale_close_leases_fail_closed() {
        let gate = CloseGate::default();
        let CloseGateDecision::Emit(cancelled) = gate.request().unwrap() else {
            panic!("request must emit");
        };
        assert!(!gate.resolve(&cancelled, CloseResolution::Cancel).unwrap());
        assert!(gate.resolve(&cancelled, CloseResolution::Close).is_err());
        let CloseGateDecision::Emit(failed) = gate.request().unwrap() else {
            panic!("request must emit");
        };
        assert!(gate.resolve(&failed, CloseResolution::Close).unwrap());
        assert!(matches!(
            gate.request().unwrap(),
            CloseGateDecision::Emit(_)
        ));
    }

    #[test]
    fn close_resolution_schema_requires_an_exact_lowercase_lease() {
        let valid = serde_json::json!({
            "lease": format!("close:v1:{}", "a".repeat(16)),
            "action": "close",
        });
        assert!(serde_json::from_value::<CloseResolutionRequest>(valid).is_ok());
        for lease in [
            "close:v1:short",
            "close:v1:AAAAAAAAAAAAAAAA",
            "watch:v1:aaaaaaaaaaaaaaaa",
        ] {
            assert!(
                serde_json::from_value::<CloseResolutionRequest>(serde_json::json!({
                    "lease": lease,
                    "action": "cancel",
                }))
                .is_err()
            );
        }
    }

    #[test]
    fn native_close_dialog_results_map_to_typed_choices() {
        assert_eq!(
            close_choice(MessageDialogResult::Custom("Save".to_string())),
            "save"
        );
        assert_eq!(close_choice(MessageDialogResult::Yes), "save");
        assert_eq!(
            close_choice(MessageDialogResult::Custom("Discard".to_string())),
            "discard"
        );
        assert_eq!(close_choice(MessageDialogResult::No), "discard");
        assert_eq!(close_choice(MessageDialogResult::Cancel), "cancel");
        assert_eq!(
            close_choice(MessageDialogResult::Custom("unexpected".to_string())),
            "cancel"
        );
    }

    #[test]
    fn generic_confirmation_accepts_only_the_confirm_button() {
        assert!(super::confirmation_result(
            MessageDialogResult::Custom("Replace".to_string()),
            "Replace"
        ));
        assert!(!super::confirmation_result(
            MessageDialogResult::Custom("Keep Current".to_string()),
            "Replace"
        ));
        assert!(super::confirmation_result(
            MessageDialogResult::Ok,
            "Replace"
        ));
        assert!(!super::confirmation_result(
            MessageDialogResult::Cancel,
            "Replace"
        ));
    }
}
