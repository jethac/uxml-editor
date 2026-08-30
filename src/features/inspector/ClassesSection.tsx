import { useEffect, useState, type KeyboardEvent } from 'react';
import type { ElementLocator } from '../../core/documents/ElementLocator';
import type { InspectorSelection } from './inspectorModel';
import type { InspectorContextToken, InspectorDraftContext } from './InspectorContext';

export interface ClassesSectionProps {
  readonly selection: readonly InspectorSelection[];
  readonly draftContext: InspectorDraftContext;
  readonly onEdit: (value: string | null, locators: readonly ElementLocator[], token: InspectorContextToken) => void;
}

export function ClassesSection({ selection, draftContext, onEdit }: ClassesSectionProps) {
  const observed = selection.map(({ node }) => node.attributes.find((attribute) => attribute.name === 'class')?.value ?? '');
  const mixed = new Set(observed).size > 1;
  const value = mixed ? '' : observed[0] ?? '';
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(value); setError(null); }, [draftContext, value, mixed]);
  const commit = () => {
    const tokens = draft.trim().length === 0 ? [] : draft.trim().split(/\s+/);
    const invalid = tokens.some((token) => !/^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(token))
      || new Set(tokens).size !== tokens.length;
    if (invalid) { setError('Classes must be unique whitespace-separated USS identifiers.'); return; }
    setError(null);
    const normalized = tokens.join(' ');
    const targets = normalized.length === 0
      ? selection.filter(({ node }) => node.attributes.some((attribute) => attribute.name === 'class')).map((item) => item.locator)
      : selection.map((item) => item.locator);
    if (targets.length > 0 && (mixed || normalized !== value)) {
      onEdit(normalized.length === 0 ? null : normalized, targets, draftContext.token);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
  };
  return (
    <section className="inspector-section" aria-labelledby="inspector-classes-heading">
      <h3 id="inspector-classes-heading">Classes</h3>
      <div className="inspector-field">
        <label htmlFor="inspector-classes">Classes</label>
        <input id="inspector-classes" aria-label="Classes" value={draft} placeholder={mixed ? 'Mixed' : 'class-a class-b'} aria-invalid={error !== null} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={keyDown} />
        <span className="inspector-origin">{mixed ? 'Mixed' : value.length === 0 ? 'None' : `${value.split(/\s+/).length} token${value.includes(' ') ? 's' : ''}`}</span>
        {error !== null && <span className="inspector-error" role="alert">{error}</span>}
      </div>
    </section>
  );
}
