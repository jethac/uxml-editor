import { useMemo, useState } from 'react';
import type { ElementLocator } from '../../core/documents/ElementLocator';
import type { EditorSnapshot, EditorStore } from '../../core/store/EditorStore';
import { AppearanceSection } from './AppearanceSection';
import { AttributeSection } from './AttributeSection';
import { ClassesSection } from './ClassesSection';
import { composeAttributeEdit, composeStyleEdit } from './inspectorTransactions';
import {
  activeStatesFor,
  inspectorSelection,
  styleFieldModel,
  type InspectorStyleChoice,
  type InspectorStyleFieldModel,
} from './inspectorModel';
import { LayoutSection } from './LayoutSection';
import { propertiesForSection } from './propertyCatalog';
import { StyleTargetMenu } from './StyleTargetMenu';
import { TypographySection } from './TypographySection';

export interface InspectorPanelProps {
  readonly store: EditorStore;
  readonly snapshot: EditorSnapshot;
}

interface PendingStyleEdit {
  readonly field: InspectorStyleFieldModel;
  readonly value: string;
}

export function InspectorPanel({ store, snapshot }: InspectorPanelProps) {
  const session = snapshot.session;
  const selection = useMemo(
    () => inspectorSelection(snapshot),
    [session, snapshot.selection, snapshot.sessionGeneration],
  );
  const [pending, setPending] = useState<PendingStyleEdit | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const fieldGroups = useMemo(() => {
    const models = (section: 'layout' | 'appearance' | 'typography') => session === null
      ? []
      : propertiesForSection(section).map((definition) =>
        styleFieldModel(session, selection, snapshot.activeStates, definition)
      );
    return { layout: models('layout'), appearance: models('appearance'), typography: models('typography') };
  }, [session, selection, snapshot.activeStates, snapshot.sessionGeneration]);
  const states = selection.length === 1 ? activeStatesFor(snapshot.activeStates, selection[0].locator) : [];

  const executeStyle = (field: InspectorStyleFieldModel, value: string, choice: InspectorStyleChoice) => {
    if (session === null) return;
    try {
      session.history.execute(composeStyleEdit(session, choice.edits, value));
      setPending(null);
      setDiagnostic(null);
      store.dispatch({ type: 'session/sync' });
    } catch (error) {
      setPending(null);
      setDiagnostic(errorMessage(error));
    }
  };

  const requestStyleEdit = (field: InspectorStyleFieldModel, value: string) => {
    setDiagnostic(null);
    if (field.choices.length === 0) {
      setDiagnostic(field.unavailableReason ?? `No compatible write target is available for ${field.definition.property}.`);
    } else if (field.choices.length === 1) {
      executeStyle(field, value, field.choices[0]);
    } else {
      setPending({ field, value });
    }
  };

  const editAttribute = (name: string, value: string | null, locators: readonly ElementLocator[]) => {
    if (session === null) return;
    try {
      session.history.execute(composeAttributeEdit(session, locators, name, value));
      setDiagnostic(null);
      store.dispatch({ type: 'session/sync' });
    } catch (error) {
      setDiagnostic(errorMessage(error));
    }
  };

  if (session === null) return <span className="pane-empty">No document</span>;
  if (selection.length === 0) return <span className="pane-empty">Nothing selected</span>;
  return (
    <div className="inspector-panel">
      <div className="inspector-context" aria-label="Inspector selection context">
        <strong>{selection.length === 1 ? selection[0].node.name : `${selection.length} elements`}</strong>
        <span>{states.length === 0 ? 'Base state' : states.map(capitalize).join(' + ')}</span>
      </div>
      {diagnostic !== null && <div className="inspector-diagnostic" role="alert">{diagnostic}</div>}
      <AttributeSection selection={selection} onEdit={editAttribute} />
      <ClassesSection selection={selection} onEdit={(value, locators) => editAttribute('class', value, locators)} />
      <LayoutSection fields={fieldGroups.layout} onEdit={requestStyleEdit} />
      <AppearanceSection fields={fieldGroups.appearance} onEdit={requestStyleEdit} />
      <TypographySection fields={fieldGroups.typography} onEdit={requestStyleEdit} />
      {pending !== null && (
        <StyleTargetMenu
          property={pending.field.definition.property}
          choices={pending.field.choices}
          returnFocusId={`inspector-style-${pending.field.definition.property}`}
          onCancel={() => setPending(null)}
          onChoose={(choice) => executeStyle(pending.field, pending.value, choice)}
        />
      )}
    </div>
  );
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'The inspector edit could not be applied.';
}
