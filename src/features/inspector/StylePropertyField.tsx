import { FolderSearch } from 'lucide-react';
import { useEffect, useState, type ChangeEvent, type FocusEvent } from 'react';
import type { InspectorStyleFieldModel } from './inspectorModel';
import { colorSwatchValue, validateInspectorValue } from './propertyCatalog';

export interface StylePropertyFieldProps {
  readonly field: InspectorStyleFieldModel;
  readonly onEdit: (field: InspectorStyleFieldModel, value: string) => void;
}

export function StylePropertyField({ field, onEdit }: StylePropertyFieldProps) {
  const { definition } = field;
  const inputId = `inspector-style-${definition.property}`;
  const [draft, setDraft] = useState(field.value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(field.value);
    setError(null);
  }, [field.value, field.mixed]);

  const update = (value: string, commitWhenValid: boolean) => {
    setDraft(value);
    const validation = value.length === 0 ? null : validateInspectorValue(definition, value);
    setError(validation);
    if (commitWhenValid && validation === null && value.length > 0 && (field.mixed || value !== field.value)) onEdit(field, value);
  };
  const blur = (event: FocusEvent<HTMLInputElement>) => {
    const validation = validateInspectorValue(definition, event.currentTarget.value);
    setError(validation);
  };
  const change = (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => update(event.target.value, true);

  return (
    <div className="inspector-field" data-property={definition.property}>
      <label htmlFor={inputId}>{definition.label}</label>
      <div className="inspector-control">
        {definition.kind === 'enum'
          ? (
              <select id={inputId} aria-label={definition.label} value={draft} aria-invalid={error !== null} onChange={change}>
                {(field.mixed || !definition.values?.includes(draft)) && <option value="">{field.mixed ? 'Mixed' : 'Unavailable'}</option>}
                {definition.values?.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            )
          : (
              <div className={`inspector-input-wrap inspector-input-wrap--${definition.kind}`}>
                {definition.kind === 'color' && (
                  <span
                    className="inspector-color-swatch"
                    aria-label={`${definition.label} swatch`}
                    style={{ backgroundColor: colorSwatchValue(draft) }}
                  />
                )}
                <input
                  id={inputId}
                  aria-label={definition.label}
                  value={draft}
                  placeholder={field.mixed ? 'Mixed' : undefined}
                  aria-invalid={error !== null}
                  aria-describedby={`${inputId}-origin${error === null ? '' : ` ${inputId}-error`}`}
                  list={definition.kind === 'asset' ? `${inputId}-values` : undefined}
                  onChange={change}
                  onBlur={blur}
                />
                {definition.kind === 'asset' && (
                  <>
                    <datalist id={`${inputId}-values`}><option value="none" />{field.value.length > 0 && <option value={field.value} />}</datalist>
                    <button type="button" aria-label={`Available ${definition.label.toLowerCase()} values`} title="Available asset values" onClick={() => document.getElementById(inputId)?.focus()}>
                      <FolderSearch aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            )}
      </div>
      <span id={`${inputId}-origin`} className="inspector-origin" title={field.origin.title}>{field.mixed ? 'Mixed' : field.origin.label}</span>
      {error !== null && <span id={`${inputId}-error`} className="inspector-error" role="alert">{error}</span>}
    </div>
  );
}
