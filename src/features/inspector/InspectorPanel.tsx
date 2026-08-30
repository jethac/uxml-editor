import { useEffect, useMemo, useState } from 'react';
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
import {
  createInspectorDraftContext,
  inspectorContextMatches,
  inspectorPostCommitContextMatches,
  type InspectorContextToken,
} from './InspectorContext';

export interface InspectorPanelProps {
  readonly store: EditorStore;
  readonly snapshot: EditorSnapshot;
}

interface PendingStyleEdit {
  readonly field: InspectorStyleFieldModel;
  readonly value: string;
  readonly token: InspectorContextToken;
  readonly origin: HTMLElement;
}

type StyleExecutionOutcome =
  | Readonly<{ status: 'committed'; generation: number }>
  | Readonly<{ status: 'stale' | 'failed' }>;

export function InspectorPanel({ store, snapshot }: InspectorPanelProps) {
  const session = snapshot.session;
  const selection = useMemo(
    () => inspectorSelection(snapshot),
    [session, snapshot.selection, snapshot.sessionGeneration],
  );
  const [pending, setPending] = useState<PendingStyleEdit | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const draftContext = useMemo(
    () => createInspectorDraftContext(snapshot, selection),
    [session, selection, snapshot.activeStates, snapshot.projectAssets, snapshot.sessionGeneration],
  );
  useEffect(() => {
    setPending(null);
    setDiagnostic(null);
  }, [draftContext]);
  const fieldGroups = useMemo(() => {
    const models = (section: 'layout' | 'appearance' | 'typography') => session === null
      ? []
      : propertiesForSection(section).map((definition) =>
        styleFieldModel(session, selection, snapshot.activeStates, definition)
      );
    return { layout: models('layout'), appearance: models('appearance'), typography: models('typography') };
  }, [session, selection, snapshot.activeStates, snapshot.sessionGeneration]);
  const states = selection.length === 1 && session !== null
    ? activeStatesFor(session.document.root, snapshot.activeStates, selection[0].locator)
    : [];

  const executeStyle = (field: InspectorStyleFieldModel, value: string, choice: InspectorStyleChoice, token: InspectorContextToken): StyleExecutionOutcome => {
    const current = store.getSnapshot();
    if (!inspectorContextMatches(current, token)) {
      setPending(null);
      setDiagnostic(null);
      return { status: 'stale' };
    }
    try {
      token.session.history.execute(composeStyleEdit(token.session, choice.edits, value));
      const generation = token.session.generation;
      setPending(null);
      setDiagnostic(null);
      store.dispatch({ type: 'session/sync' });
      return { status: 'committed', generation };
    } catch (error) {
      setPending(null);
      if (inspectorContextMatches(store.getSnapshot(), token)) setDiagnostic(errorMessage(error));
      else setDiagnostic(null);
      return { status: 'failed' };
    }
  };

  const requestStyleEdit = (field: InspectorStyleFieldModel, value: string, token: InspectorContextToken, origin: HTMLElement) => {
    if (!inspectorContextMatches(store.getSnapshot(), token)) {
      setPending(null);
      setDiagnostic(null);
      return;
    }
    setDiagnostic(null);
    if (field.choices.length === 0) {
      setDiagnostic(field.unavailableReason ?? `No compatible write target is available for ${field.definition.property}.`);
    } else if (field.choices.length === 1) {
      executeStyle(field, value, field.choices[0], token);
    } else {
      setPending({ field, value, token, origin });
    }
  };

  const editAttribute = (name: string, value: string | null, locators: readonly ElementLocator[], token: InspectorContextToken) => {
    if (!inspectorContextMatches(store.getSnapshot(), token)) {
      setPending(null);
      setDiagnostic(null);
      return;
    }
    try {
      token.session.history.execute(composeAttributeEdit(token.session, locators, name, value));
      setDiagnostic(null);
      store.dispatch({ type: 'session/sync' });
    } catch (error) {
      if (inspectorContextMatches(store.getSnapshot(), token)) setDiagnostic(errorMessage(error));
      else setDiagnostic(null);
    }
  };

  const cancelPendingStyle = (edit: PendingStyleEdit) => {
    setPending(null);
    setDiagnostic(null);
    queueMicrotask(() => {
      if (edit.origin.isConnected && inspectorContextMatches(store.getSnapshot(), edit.token)) edit.origin.focus();
    });
  };

  const choosePendingStyle = (edit: PendingStyleEdit, choice: InspectorStyleChoice) => {
    const outcome = executeStyle(edit.field, edit.value, choice, edit.token);
    if (outcome.status !== 'committed') return;
    queueMicrotask(() => {
      if (
        edit.origin.isConnected
        && inspectorPostCommitContextMatches(store.getSnapshot(), edit.token, outcome.generation)
      ) edit.origin.focus();
    });
  };

  if (session === null) return <span className="pane-empty">No document</span>;
  if (selection.length === 0) return <span className="pane-empty">Nothing selected</span>;
  if (draftContext === null) return <span className="pane-empty">Nothing selected</span>;
  return (
    <div className="inspector-panel">
      <div className="inspector-context" aria-label="Inspector selection context">
        <strong>{selection.length === 1 ? selection[0].node.name : `${selection.length} elements`}</strong>
        <span>{states.length === 0 ? 'Base state' : states.map(capitalize).join(' + ')}</span>
      </div>
      {diagnostic !== null && <div className="inspector-diagnostic" role="alert">{diagnostic}</div>}
      <AttributeSection selection={selection} draftContext={draftContext} projectAssets={snapshot.projectAssets} onEdit={editAttribute} />
      <ClassesSection selection={selection} draftContext={draftContext} onEdit={(value, locators, token) => editAttribute('class', value, locators, token)} />
      <LayoutSection fields={fieldGroups.layout} draftContext={draftContext} projectAssets={snapshot.projectAssets} onEdit={requestStyleEdit} />
      <AppearanceSection fields={fieldGroups.appearance} draftContext={draftContext} projectAssets={snapshot.projectAssets} onEdit={requestStyleEdit} />
      <TypographySection fields={fieldGroups.typography} draftContext={draftContext} projectAssets={snapshot.projectAssets} onEdit={requestStyleEdit} />
      {pending !== null && (
        <StyleTargetMenu
          property={pending.field.definition.property}
          choices={pending.field.choices}
          onCancel={() => cancelPendingStyle(pending)}
          onChoose={(choice) => choosePendingStyle(pending, choice)}
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
