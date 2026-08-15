use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
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
}

pub const MENU_COMMANDS: &[MenuCommandSpec] = &[
    MenuCommandSpec {
        id: "file.open-project",
        label: "Open Project...",
        accelerator: Some("Ctrl+O"),
        section: MenuSection::File,
    },
    MenuCommandSpec {
        id: "file.save",
        label: "Save",
        accelerator: Some("Ctrl+S"),
        section: MenuSection::File,
    },
    MenuCommandSpec {
        id: "file.save-all",
        label: "Save All",
        accelerator: Some("Ctrl+Shift+S"),
        section: MenuSection::File,
    },
    MenuCommandSpec {
        id: "file.close-project",
        label: "Close Project",
        accelerator: Some("Ctrl+Shift+W"),
        section: MenuSection::File,
    },
    MenuCommandSpec {
        id: "edit.undo",
        label: "Undo",
        accelerator: Some("Ctrl+Z"),
        section: MenuSection::Edit,
    },
    MenuCommandSpec {
        id: "edit.redo",
        label: "Redo",
        accelerator: Some("Ctrl+Y"),
        section: MenuSection::Edit,
    },
    MenuCommandSpec {
        id: "view.zoom-in",
        label: "Zoom In",
        accelerator: Some("Ctrl+="),
        section: MenuSection::View,
    },
    MenuCommandSpec {
        id: "view.zoom-out",
        label: "Zoom Out",
        accelerator: Some("Ctrl+-"),
        section: MenuSection::View,
    },
    MenuCommandSpec {
        id: "view.pane-hierarchy",
        label: "Hierarchy Pane",
        accelerator: Some("Ctrl+Alt+1"),
        section: MenuSection::View,
    },
    MenuCommandSpec {
        id: "view.pane-inspector",
        label: "Inspector Pane",
        accelerator: Some("Ctrl+Alt+2"),
        section: MenuSection::View,
    },
    MenuCommandSpec {
        id: "view.pane-diagnostics",
        label: "Diagnostics Pane",
        accelerator: Some("Ctrl+Alt+3"),
        section: MenuSection::View,
    },
    MenuCommandSpec {
        id: "view.pane-source",
        label: "Source Pane",
        accelerator: Some("Ctrl+Alt+4"),
        section: MenuSection::View,
    },
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuCommandPayload {
    pub command_id: String,
}

pub fn is_desktop_command(id: &str) -> bool {
    MENU_COMMANDS.iter().any(|command| command.id == id)
}

pub struct CloseGate {
    authorized: AtomicBool,
}

impl Default for CloseGate {
    fn default() -> Self {
        Self {
            authorized: AtomicBool::new(false),
        }
    }
}

impl CloseGate {
    pub fn authorize_once(&self) {
        self.authorized.store(true, Ordering::Release);
    }

    pub fn revoke_authorization(&self) {
        self.authorized.store(false, Ordering::Release);
    }

    pub fn should_intercept(&self) -> bool {
        !self.authorized.swap(false, Ordering::AcqRel)
    }
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

fn build_submenu<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    section: MenuSection,
) -> tauri::Result<Submenu<R>> {
    let mut builder = SubmenuBuilder::new(app, title);
    for command in MENU_COMMANDS.iter().filter(|item| item.section == section) {
        let mut item = MenuItemBuilder::with_id(command.id, command.label);
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
    use super::{close_choice, is_desktop_command, CloseGate, MenuSection, MENU_COMMANDS};
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
    fn close_authorization_is_single_use() {
        let gate = CloseGate::default();
        assert!(gate.should_intercept());
        gate.authorize_once();
        assert!(!gate.should_intercept());
        assert!(gate.should_intercept());
    }

    #[test]
    fn close_authorization_can_be_revoked_after_a_failed_window_call() {
        let gate = CloseGate::default();
        gate.authorize_once();
        gate.revoke_authorization();
        assert!(gate.should_intercept());
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
