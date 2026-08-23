use crate::{
    error::HostError,
    identifiers::{
        deserialize_close_lease, deserialize_lifecycle_generation, deserialize_workflow_generation,
        is_exact_hex_identifier,
    },
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};
use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, Submenu, SubmenuBuilder},
    AppHandle, Runtime,
};
use tauri_plugin_dialog::MessageDialogResult;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum MenuSection {
    File,
    Edit,
    View,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuCommandSpec {
    pub id: String,
    pub label: String,
    pub accelerator: Option<String>,
    pub section: MenuSection,
    pub enabled_by_default: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedCommandSpec {
    id: String,
    label: String,
    section: MenuSection,
    windows_accelerator: Option<String>,
    mac_accelerator: Option<String>,
    native: bool,
    native_enabled_by_default: bool,
}

fn menu_commands() -> &'static [MenuCommandSpec] {
    static COMMANDS: OnceLock<Vec<MenuCommandSpec>> = OnceLock::new();
    COMMANDS.get_or_init(|| {
        let shared: Vec<SharedCommandSpec> =
            serde_json::from_str(include_str!("../../src/core/store/CommandDefinitions.json"))
                .expect("shared command definitions must be valid");
        let commands: Vec<_> = shared
            .into_iter()
            .filter(|command| command.native)
            .map(|command| MenuCommandSpec {
                id: command.id,
                label: command.label,
                accelerator: if cfg!(target_os = "macos") {
                    command.mac_accelerator
                } else {
                    command.windows_accelerator
                },
                section: command.section,
                enabled_by_default: command.native_enabled_by_default,
            })
            .collect();
        let mut identities = std::collections::HashSet::new();
        assert!(
            commands
                .iter()
                .all(|command| identities.insert(command.id.clone())),
            "native command identities must be unique"
        );
        commands
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuCommandPayload {
    pub command_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileWorkflowEnabledRequest {
    #[serde(deserialize_with = "deserialize_workflow_generation")]
    pub workflow_generation: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleReadyRequest {
    #[serde(deserialize_with = "deserialize_lifecycle_generation")]
    pub lifecycle_generation: String,
    pub ready: bool,
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
    #[serde(deserialize_with = "deserialize_lifecycle_generation")]
    pub lifecycle_generation: String,
    pub action: CloseResolution,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseAbandonRequest {
    #[serde(deserialize_with = "deserialize_close_lease")]
    pub lease: String,
    #[serde(deserialize_with = "deserialize_lifecycle_generation")]
    pub lifecycle_generation: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseRequestPayload {
    pub lease: String,
    pub lifecycle_generation: String,
}

pub fn is_desktop_command(id: &str) -> bool {
    menu_commands().iter().any(|command| command.id == id)
}

#[derive(Default)]
pub struct CloseGate {
    state: Mutex<CloseState>,
    next_lease: AtomicU64,
}

#[derive(Default)]
struct CloseState {
    ready: Option<String>,
    pending: Option<CloseDelivery>,
}

impl CloseGate {
    pub fn set_ready(&self, lifecycle_generation: &str, ready: bool) -> Result<(), HostError> {
        let sequence = lifecycle_sequence(lifecycle_generation)?;
        let mut state = self.lock()?;
        if ready {
            let current_sequence = state
                .ready
                .as_deref()
                .map(lifecycle_sequence)
                .transpose()?
                .unwrap_or(0);
            if sequence < current_sequence {
                return Ok(());
            }
            if state.ready.as_deref() != Some(lifecycle_generation) {
                state.pending = None;
            }
            state.ready = Some(lifecycle_generation.to_string());
        } else if state.ready.as_deref() == Some(lifecycle_generation) {
            state.ready = None;
            if state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.lifecycle_generation == lifecycle_generation)
            {
                state.pending = None;
            }
        }
        Ok(())
    }

    pub fn request(&self) -> Result<CloseGateDecision, HostError> {
        let mut state = self.lock()?;
        let Some(lifecycle_generation) = state.ready.clone() else {
            return Ok(CloseGateDecision::Prevent);
        };
        if let Some(pending) = state.pending.as_ref() {
            return Ok(CloseGateDecision::Emit(pending.clone()));
        }
        let lease = format!(
            "close:v1:{:016x}",
            self.next_lease.fetch_add(1, Ordering::Relaxed)
        );
        let delivery = CloseDelivery {
            lease,
            lifecycle_generation,
        };
        state.pending = Some(delivery.clone());
        Ok(CloseGateDecision::Emit(delivery))
    }

    pub fn request_for_delivery(
        &self,
        emit: impl FnOnce(&CloseDelivery) -> Result<(), HostError>,
    ) -> Result<CloseGateDecision, HostError> {
        let decision = self.request()?;
        if let CloseGateDecision::Emit(delivery) = &decision {
            if let Err(error) = emit(delivery) {
                let mut state = self.lock()?;
                if state.pending.as_ref() == Some(delivery) {
                    state.pending = None;
                }
                return Err(error);
            }
        }
        Ok(decision)
    }

    pub fn resolve(
        &self,
        lease: &str,
        lifecycle_generation: &str,
        resolution: CloseResolution,
    ) -> Result<bool, HostError> {
        let mut state = self.lock()?;
        if !state.pending.as_ref().is_some_and(|pending| {
            pending.lease == lease && pending.lifecycle_generation == lifecycle_generation
        }) {
            return Err(HostError::new(
                "read-failed",
                "Desktop close lease is not current.",
            ));
        }
        state.pending = None;
        Ok(resolution == CloseResolution::Close)
    }

    pub fn abandon(&self, lease: &str, lifecycle_generation: &str) -> Result<(), HostError> {
        let mut state = self.lock()?;
        if state.pending.as_ref().is_some_and(|pending| {
            pending.lease == lease && pending.lifecycle_generation == lifecycle_generation
        }) {
            state.pending = None;
        }
        Ok(())
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
    Emit(CloseDelivery),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloseDelivery {
    pub lease: String,
    pub lifecycle_generation: String,
}

fn lifecycle_sequence(value: &str) -> Result<u64, HostError> {
    if !is_exact_hex_identifier(value, "lifecycle:v1:", 16) {
        return Err(HostError::new(
            "read-failed",
            "Desktop lifecycle generation is malformed.",
        ));
    }
    u64::from_str_radix(&value["lifecycle:v1:".len()..], 16)
        .map_err(|_| HostError::new("read-failed", "Desktop lifecycle generation is malformed."))
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

pub fn set_file_workflow_enabled<R: Runtime>(
    menu: &Menu<R>,
    enabled: bool,
) -> Result<(), HostError> {
    let mut items = Vec::new();
    for item in menu.items().map_err(|error| {
        HostError::new(
            "read-failed",
            format!("Could not inspect native file commands: {error}"),
        )
    })? {
        let Some(submenu) = item.as_submenu() else {
            continue;
        };
        for id in ["file.save", "file.save-all", "file.close-project"] {
            if let Some(item) = submenu.get(id).and_then(|item| item.as_menuitem().cloned()) {
                items.push((id, item));
            }
        }
    }
    if items.len() != 3 {
        return Err(HostError::new(
            "read-failed",
            "Native file-workflow menu items are unavailable.",
        ));
    }
    transition_file_workflow_items(
        enabled,
        |id| {
            items
                .iter()
                .find(|(item_id, _)| *item_id == id)
                .ok_or_else(|| HostError::new("read-failed", "Native menu item is unavailable."))?
                .1
                .is_enabled()
                .map_err(|error| {
                    HostError::new(
                        "read-failed",
                        format!("Could not inspect native file command {id}: {error}"),
                    )
                })
        },
        |id, requested| {
            items
                .iter()
                .find(|(item_id, _)| *item_id == id)
                .ok_or_else(|| HostError::new("read-failed", "Native menu item is unavailable."))?
                .1
                .set_enabled(requested)
                .map_err(|error| {
                    HostError::new(
                        "read-failed",
                        format!("Could not update native file command {id}: {error}"),
                    )
                })
        },
    )
}

fn transition_file_workflow_items(
    enabled: bool,
    mut read: impl FnMut(&str) -> Result<bool, HostError>,
    mut write: impl FnMut(&str, bool) -> Result<(), HostError>,
) -> Result<(), HostError> {
    let mut prior = Vec::with_capacity(FILE_WORKFLOW_MENU_IDS.len());
    for id in FILE_WORKFLOW_MENU_IDS {
        prior.push(read(id)?);
    }
    for (index, id) in FILE_WORKFLOW_MENU_IDS.into_iter().enumerate() {
        if let Err(failure) = write(id, enabled) {
            let mut rollback_failure = None;
            for rollback_index in (0..index).rev() {
                if let Err(error) = write(
                    FILE_WORKFLOW_MENU_IDS[rollback_index],
                    prior[rollback_index],
                ) {
                    rollback_failure = Some(error);
                }
            }
            return Err(match rollback_failure {
                Some(rollback) => HostError::new(
                    "read-failed",
                    format!(
                        "{} Native file-menu rollback also failed: {}",
                        failure.message, rollback.message
                    ),
                ),
                None => failure,
            });
        }
    }
    Ok(())
}

const FILE_WORKFLOW_MENU_IDS: [&str; 3] = ["file.save", "file.save-all", "file.close-project"];

#[derive(Default)]
pub struct FileWorkflowGate {
    generation: Mutex<Option<String>>,
}

impl FileWorkflowGate {
    pub fn transition(
        &self,
        workflow_generation: &str,
        operation: impl FnOnce() -> Result<(), HostError>,
    ) -> Result<(), HostError> {
        let requested = workflow_sequence(workflow_generation)?;
        let mut current = self.generation.lock().map_err(|_| {
            HostError::new("read-failed", "Native file-workflow state is unavailable.")
        })?;
        let current_sequence = current
            .as_deref()
            .map(workflow_sequence)
            .transpose()?
            .unwrap_or(0);
        if requested < current_sequence {
            return Ok(());
        }
        operation()?;
        *current = Some(workflow_generation.to_string());
        Ok(())
    }
}

fn workflow_sequence(value: &str) -> Result<u64, HostError> {
    if !is_exact_hex_identifier(value, "workflow:v1:", 16) {
        return Err(HostError::new(
            "read-failed",
            "Desktop workflow generation is malformed.",
        ));
    }
    u64::from_str_radix(&value["workflow:v1:".len()..], 16)
        .map_err(|_| HostError::new("read-failed", "Desktop workflow generation is malformed."))
}

fn build_submenu<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    section: MenuSection,
) -> tauri::Result<Submenu<R>> {
    let mut builder = SubmenuBuilder::new(app, title);
    for command in menu_commands()
        .iter()
        .filter(|item| item.section == section)
    {
        let mut item = MenuItemBuilder::with_id(command.id.as_str(), command.label.as_str());
        item = item.enabled(command.enabled_by_default);
        if let Some(accelerator) = command.accelerator.as_deref() {
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
        close_choice, is_desktop_command, menu_commands, transition_file_workflow_items, CloseGate,
        CloseGateDecision, CloseResolution, CloseResolutionRequest, FileWorkflowEnabledRequest,
        FileWorkflowGate, MenuSection, FILE_WORKFLOW_MENU_IDS,
    };
    use crate::error::HostError;
    use tauri_plugin_dialog::MessageDialogResult;

    #[test]
    fn menu_ids_exactly_match_the_typed_frontend_bridge() {
        let actual: Vec<_> = menu_commands()
            .iter()
            .map(|item| item.id.as_str())
            .collect();
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
            menu_commands()
                .iter()
                .filter(|item| item.section == MenuSection::File)
                .count(),
            4
        );
        assert!(menu_commands()
            .iter()
            .all(|item| !item.label.is_empty() && item.accelerator.is_some()));
    }

    #[test]
    fn native_menu_metadata_matches_the_shared_declarative_command_source() {
        let shared: serde_json::Value =
            serde_json::from_str(include_str!("../../src/core/store/CommandDefinitions.json"))
                .unwrap();
        let platform_accelerator = if cfg!(target_os = "macos") {
            "macAccelerator"
        } else {
            "windowsAccelerator"
        };
        let expected: Vec<_> = shared
            .as_array()
            .unwrap()
            .iter()
            .filter(|command| command["native"].as_bool() == Some(true))
            .map(|command| {
                (
                    command["id"].as_str().unwrap(),
                    command["label"].as_str().unwrap(),
                    command["section"].as_str().unwrap(),
                    command[platform_accelerator].as_str(),
                )
            })
            .collect();
        let actual: Vec<_> = menu_commands()
            .iter()
            .map(|command| {
                let section = match command.section {
                    MenuSection::File => "File",
                    MenuSection::Edit => "Edit",
                    MenuSection::View => "View",
                };
                (
                    command.id.as_str(),
                    command.label.as_str(),
                    section,
                    command.accelerator.as_deref(),
                )
            })
            .collect();

        assert_eq!(actual, expected);
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
            let command = menu_commands()
                .iter()
                .find(|command| command.id == id)
                .unwrap();
            assert!(!command.enabled_by_default, "{id} must start disabled");
        }
        assert!(
            menu_commands()
                .iter()
                .find(|command| command.id == "file.open-project")
                .unwrap()
                .enabled_by_default
        );
    }

    #[test]
    fn partial_file_menu_failure_rolls_every_item_back_to_its_prior_state() {
        let states = std::cell::RefCell::new(std::collections::HashMap::from([
            ("file.save", false),
            ("file.save-all", false),
            ("file.close-project", false),
        ]));

        let result = transition_file_workflow_items(
            true,
            |id| {
                states
                    .borrow()
                    .get(id)
                    .copied()
                    .ok_or_else(|| HostError::new("read-failed", "missing fake menu item"))
            },
            |id, enabled| {
                if id == "file.save-all" && enabled {
                    return Err(HostError::new(
                        "read-failed",
                        "injected second-item failure",
                    ));
                }
                *states
                    .borrow_mut()
                    .get_mut(id)
                    .ok_or_else(|| HostError::new("read-failed", "missing fake menu item"))? =
                    enabled;
                Ok(())
            },
        );

        assert!(result.is_err());
        for id in FILE_WORKFLOW_MENU_IDS {
            assert!(!states.borrow()[id], "{id} was not rolled back");
        }
    }

    #[test]
    fn stale_file_workflow_generation_cannot_disable_current_items() {
        let gate = FileWorkflowGate::default();
        let enabled = std::cell::Cell::new(false);
        gate.transition("workflow:v1:0000000000000002", || {
            enabled.set(true);
            Ok(())
        })
        .unwrap();

        gate.transition("workflow:v1:0000000000000001", || {
            enabled.set(false);
            Ok(())
        })
        .unwrap();

        assert!(enabled.get());
    }

    #[test]
    fn file_workflow_schema_requires_an_exact_generation_and_boolean() {
        assert!(
            serde_json::from_value::<FileWorkflowEnabledRequest>(serde_json::json!({
                "workflowGeneration": "workflow:v1:0000000000000001",
                "enabled": true,
            }))
            .is_ok()
        );
        for generation in [
            "workflow:v1:short",
            "workflow:v1:AAAAAAAAAAAAAAAA",
            "lifecycle:v1:0000000000000001",
        ] {
            assert!(
                serde_json::from_value::<FileWorkflowEnabledRequest>(serde_json::json!({
                    "workflowGeneration": generation,
                    "enabled": false,
                }))
                .is_err()
            );
        }
    }

    #[test]
    fn close_lease_is_single_use_and_duplicate_native_requests_are_coalesced() {
        let gate = CloseGate::default();
        gate.set_ready(LIFECYCLE_ONE, true).unwrap();
        let CloseGateDecision::Emit(delivery) = gate.request().unwrap() else {
            panic!("first request must emit");
        };
        assert_eq!(
            gate.request().unwrap(),
            CloseGateDecision::Emit(delivery.clone())
        );
        assert!(gate
            .resolve(
                &delivery.lease,
                &delivery.lifecycle_generation,
                CloseResolution::Close
            )
            .unwrap());
        assert!(matches!(
            gate.request().unwrap(),
            CloseGateDecision::Emit(_)
        ));
    }

    #[test]
    fn close_before_frontend_readiness_does_not_create_a_pending_lease() {
        let gate = CloseGate::default();

        assert_eq!(gate.request().unwrap(), CloseGateDecision::Prevent);
        assert_eq!(gate.request().unwrap(), CloseGateDecision::Prevent);
    }

    #[test]
    fn stale_lifecycle_withdrawal_cannot_disable_the_current_close_generation() {
        let gate = CloseGate::default();
        gate.set_ready(LIFECYCLE_ONE, true).unwrap();
        gate.set_ready(LIFECYCLE_TWO, true).unwrap();

        gate.set_ready(LIFECYCLE_ONE, false).unwrap();

        let CloseGateDecision::Emit(delivery) = gate.request().unwrap() else {
            panic!("current generation was withdrawn by stale cleanup");
        };
        assert_eq!(delivery.lifecycle_generation, LIFECYCLE_TWO);
    }

    #[test]
    fn failed_close_event_delivery_cancels_the_exact_pending_lease() {
        let gate = CloseGate::default();
        gate.set_ready(LIFECYCLE_ONE, true).unwrap();

        let delivery = gate
            .request_for_delivery(|_| Err(HostError::new("read-failed", "injected emit failure")));

        assert!(delivery.is_err());
        assert!(matches!(
            gate.request().unwrap(),
            CloseGateDecision::Emit(_)
        ));
    }

    #[test]
    fn cancelled_failed_and_stale_close_leases_fail_closed() {
        let gate = CloseGate::default();
        gate.set_ready(LIFECYCLE_ONE, true).unwrap();
        let CloseGateDecision::Emit(cancelled) = gate.request().unwrap() else {
            panic!("request must emit");
        };
        assert!(!gate
            .resolve(
                &cancelled.lease,
                &cancelled.lifecycle_generation,
                CloseResolution::Cancel
            )
            .unwrap());
        assert!(gate
            .resolve(
                &cancelled.lease,
                &cancelled.lifecycle_generation,
                CloseResolution::Close
            )
            .is_err());
        let CloseGateDecision::Emit(failed) = gate.request().unwrap() else {
            panic!("request must emit");
        };
        assert!(gate
            .resolve(
                &failed.lease,
                &failed.lifecycle_generation,
                CloseResolution::Close
            )
            .unwrap());
        assert!(matches!(
            gate.request().unwrap(),
            CloseGateDecision::Emit(_)
        ));
    }

    #[test]
    fn close_resolution_schema_requires_an_exact_lowercase_lease() {
        let valid = serde_json::json!({
            "lease": format!("close:v1:{}", "a".repeat(16)),
            "lifecycleGeneration": LIFECYCLE_ONE,
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
                    "lifecycleGeneration": LIFECYCLE_ONE,
                    "action": "cancel",
                }))
                .is_err()
            );
        }
        for generation in [
            "lifecycle:v1:short",
            "lifecycle:v1:AAAAAAAAAAAAAAAA",
            "close:v1:aaaaaaaaaaaaaaaa",
        ] {
            assert!(
                serde_json::from_value::<CloseResolutionRequest>(serde_json::json!({
                    "lease": format!("close:v1:{}", "a".repeat(16)),
                    "lifecycleGeneration": generation,
                    "action": "cancel",
                }))
                .is_err()
            );
        }
    }

    #[test]
    fn abandoning_the_exact_failed_resolution_allows_a_later_close() {
        let gate = CloseGate::default();
        gate.set_ready(LIFECYCLE_ONE, true).unwrap();
        let CloseGateDecision::Emit(failed) = gate.request().unwrap() else {
            panic!("request must emit");
        };

        gate.abandon(&failed.lease, &failed.lifecycle_generation)
            .unwrap();

        assert!(matches!(
            gate.request().unwrap(),
            CloseGateDecision::Emit(_)
        ));
    }

    #[test]
    fn pending_close_lease_is_redelivered_exactly_on_a_later_native_attempt() {
        let gate = CloseGate::default();
        gate.set_ready(LIFECYCLE_ONE, true).unwrap();
        let CloseGateDecision::Emit(first) = gate.request().unwrap() else {
            panic!("first request must emit");
        };

        let CloseGateDecision::Emit(redelivered) = gate.request().unwrap() else {
            panic!("pending lease was not redelivered");
        };

        assert_eq!(redelivered, first);
        assert!(!gate
            .resolve(
                &redelivered.lease,
                &redelivered.lifecycle_generation,
                CloseResolution::Cancel,
            )
            .unwrap());
    }

    const LIFECYCLE_ONE: &str = "lifecycle:v1:0000000000000001";
    const LIFECYCLE_TWO: &str = "lifecycle:v1:0000000000000002";

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
