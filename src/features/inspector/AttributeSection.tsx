import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ElementLocator } from '../../core/documents/ElementLocator';
import type { InspectorSelection } from './inspectorModel';
import type { ProjectAsset } from '../../core/store/ProjectAssetCatalog';
import { AssetPicker } from './AssetPicker';
import type { InspectorContextToken, InspectorDraftContext } from './InspectorContext';

interface AttributeDefinition {
  readonly name: string;
  readonly label: string;
  readonly kind: 'text' | 'checkbox' | 'enum' | 'asset';
  readonly values?: readonly string[];
}

const ATTRIBUTES: readonly AttributeDefinition[] = Object.freeze([
  { name: 'name', label: 'Name', kind: 'text' },
  { name: 'text', label: 'Text', kind: 'text' },
  { name: 'tooltip', label: 'Tooltip', kind: 'text' },
  { name: 'focusable', label: 'Focusable', kind: 'checkbox' },
  { name: 'enabled', label: 'Enabled', kind: 'checkbox' },
  { name: 'tabindex', label: 'Tab index', kind: 'text' },
  { name: 'picking-mode', label: 'Picking mode', kind: 'enum', values: ['Position', 'Ignore'] },
  { name: 'view-data-key', label: 'View data key', kind: 'text' },
  { name: 'binding-path', label: 'Binding path', kind: 'text' },
  { name: 'src', label: 'Asset source', kind: 'asset' },
]);

export interface AttributeSectionProps {
  readonly selection: readonly InspectorSelection[];
  readonly draftContext: InspectorDraftContext;
  readonly projectAssets: readonly ProjectAsset[];
  readonly onEdit: (name: string, value: string | null, locators: readonly ElementLocator[], token: InspectorContextToken) => void;
}

export function AttributeSection({ selection, draftContext, projectAssets, onEdit }: AttributeSectionProps) {
  const known = new Set([...ATTRIBUTES.map((item) => item.name), 'class', 'style']);
  const unknownNames = [...new Set(selection.flatMap(({ node }) => node.attributes.map((attribute) => attribute.name)))]
    .filter((name) => !known.has(name) && name !== 'xmlns' && !name.startsWith('xmlns:'))
    .sort();
  const [advancedOpen, setAdvancedOpen] = useState(unknownNames.length > 0);
  useEffect(() => {
    if (unknownNames.length > 0) setAdvancedOpen(true);
  }, [unknownNames.length]);
  return (
    <section className="inspector-section" aria-labelledby="inspector-attributes-heading">
      <h3 id="inspector-attributes-heading">Attributes</h3>
      <div className="inspector-fields">
        {ATTRIBUTES.map((definition) => (
          <AttributeField key={definition.name} definition={definition} selection={selection} draftContext={draftContext} projectAssets={projectAssets} onEdit={onEdit} />
        ))}
      </div>
      <details className="inspector-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary>Advanced attributes</summary>
        {unknownNames.length === 0
          ? <span className="inspector-empty">No additional attributes</span>
          : (
              <table aria-label="Advanced attributes">
                <tbody>{unknownNames.map((name) => <UnknownAttributeRow key={name} name={name} selection={selection} draftContext={draftContext} projectAssets={projectAssets} onEdit={onEdit} />)}</tbody>
              </table>
            )}
      </details>
    </section>
  );
}

function AttributeField({
  definition,
  selection,
  draftContext,
  projectAssets,
  onEdit,
}: {
  readonly definition: AttributeDefinition;
  readonly selection: readonly InspectorSelection[];
  readonly draftContext: InspectorDraftContext;
  readonly projectAssets: readonly ProjectAsset[];
  readonly onEdit: AttributeSectionProps['onEdit'];
}) {
  const observed = selection.map(({ node }) => node.attributes.find((attribute) => attribute.name === definition.name)?.value ?? '');
  const mixed = new Set(observed).size > 1;
  const value = mixed ? '' : observed[0] ?? '';
  const locators = selection.map((item) => item.locator);
  if (definition.kind === 'checkbox') {
    return <AttributeCheckbox definition={definition} value={value} mixed={mixed} locators={locators} draftContext={draftContext} onEdit={onEdit} />;
  }
  return <AttributeText definition={definition} value={value} mixed={mixed} locators={locators} draftContext={draftContext} projectAssets={projectAssets} onEdit={onEdit} />;
}

function AttributeCheckbox({
  definition,
  value,
  mixed,
  locators,
  draftContext,
  onEdit,
}: {
  readonly definition: AttributeDefinition;
  readonly value: string;
  readonly mixed: boolean;
  readonly locators: readonly ElementLocator[];
  readonly draftContext: InspectorDraftContext;
  readonly onEdit: AttributeSectionProps['onEdit'];
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current !== null) ref.current.indeterminate = mixed; }, [mixed]);
  return (
    <div className="inspector-field inspector-field--checkbox">
      <label htmlFor={`inspector-attribute-${definition.name}`}>{definition.label}</label>
      <input
        ref={ref}
        id={`inspector-attribute-${definition.name}`}
        aria-label={definition.label}
        type="checkbox"
        checked={!mixed && value === 'true'}
        onChange={(event) => onEdit(definition.name, String(event.target.checked), locators, draftContext.token)}
      />
      <span className="inspector-origin">{mixed ? 'Mixed' : value.length === 0 ? 'Not authored' : 'Explicit'}</span>
    </div>
  );
}

function AttributeText({
  definition,
  value,
  mixed,
  locators,
  draftContext,
  projectAssets,
  onEdit,
}: {
  readonly definition: AttributeDefinition;
  readonly value: string;
  readonly mixed: boolean;
  readonly locators: readonly ElementLocator[];
  readonly draftContext: InspectorDraftContext;
  readonly projectAssets: readonly ProjectAsset[];
  readonly onEdit: AttributeSectionProps['onEdit'];
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(value); setError(null); }, [draftContext, value, mixed]);
  const commit = () => {
    const invalid = validateAttribute(definition, draft);
    setError(invalid);
    if (invalid === null && (mixed || draft !== value)) onEdit(definition.name, draft, locators, draftContext.token);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
  };
  const id = `inspector-attribute-${definition.name}`;
  return (
    <div className="inspector-field">
      <label htmlFor={id}>{definition.label}</label>
      <div className={`inspector-input-wrap inspector-input-wrap--${definition.kind}`}>
        {definition.kind === 'enum'
          ? (
              <select id={id} aria-label={definition.label} value={draft} onChange={(event) => { setDraft(event.target.value); onEdit(definition.name, event.target.value, locators, draftContext.token); }}>
                {(mixed || draft.length === 0) && <option value="">{mixed ? 'Mixed' : 'Not authored'}</option>}
                {definition.values?.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            )
          : <input id={id} aria-label={definition.label} value={draft} placeholder={mixed ? 'Mixed' : undefined} aria-invalid={error !== null} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={keyDown} />}
        {definition.kind === 'asset' && (
          <AssetPicker
            label={definition.label}
            assets={projectAssets}
            valueKind="attribute"
            resetKey={draftContext.key}
            onSelect={(selected) => {
              setDraft(selected);
              setError(null);
              if (mixed || selected !== value) onEdit(definition.name, selected, locators, draftContext.token);
            }}
          />
        )}
      </div>
      <span className="inspector-origin">{mixed ? 'Mixed' : value.length === 0 ? 'Not authored' : 'Authored'}</span>
      {error !== null && <span className="inspector-error" role="alert">{error}</span>}
    </div>
  );
}

function UnknownAttributeRow({ name, selection, draftContext, onEdit }: { readonly name: string } & AttributeSectionProps) {
  const observed = selection.map(({ node }) => node.attributes.find((attribute) => attribute.name === name)?.value ?? null);
  const mixed = new Set(observed.map((value) => value === null ? 'absent' : `present:${value}`)).size > 1;
  const value = mixed ? '' : observed[0] ?? '';
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(value); setError(null); }, [draftContext, value, mixed]);
  const editLocators = selection.map((item) => item.locator);
  const removeLocators = selection.filter(({ node }) => node.attributes.some((attribute) => attribute.name === name)).map((item) => item.locator);
  const commit = () => {
    const invalid = validateText(draft);
    setError(invalid);
    if (invalid === null && (mixed || draft !== value)) onEdit(name, draft, editLocators, draftContext.token);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
  };
  return (
    <tr>
      <th scope="row">{name}</th>
      <td><input aria-label={`${name} value`} value={draft} placeholder={mixed ? 'Mixed' : undefined} aria-invalid={error !== null} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={keyDown} /></td>
      <td>
        <button type="button" aria-label={`Remove ${name}`} title={`Remove ${name}`} onClick={() => onEdit(name, null, removeLocators, draftContext.token)}><Trash2 aria-hidden="true" /></button>
        {error !== null && <span className="visually-hidden" role="alert">{error}</span>}
      </td>
    </tr>
  );
}

function validateAttribute(definition: AttributeDefinition, value: string): string | null {
  if (definition.kind === 'asset') {
    if (value.length === 0) return null;
    if (/^(?:project:\/\/database\/)?(?:Assets|Packages)\/[A-Za-z0-9_./ -]+$/.test(value) && !value.includes('..')) return null;
    if (/^resource:\/\/[A-Za-z0-9_./ -]+$/.test(value) && !value.includes('..')) return null;
    return 'Use a project asset or resource path without parent traversal.';
  }
  if (definition.kind === 'enum') return definition.values?.includes(value) ? null : 'Choose an available value.';
  if (definition.name === 'tabindex' && value.length > 0 && !/^-?\d+$/.test(value)) return 'Use a complete integer.';
  return validateText(value);
}

function validateText(value: string): string | null {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value) ? 'The value contains unsupported control characters.' : null;
}
