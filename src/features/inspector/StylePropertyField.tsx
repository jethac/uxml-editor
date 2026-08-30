import { useEffect, useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent } from 'react';
import type { ProjectAsset } from '../../core/store/ProjectAssetCatalog';
import type { InspectorContextToken, InspectorDraftContext } from './InspectorContext';
import type { InspectorStyleFieldModel } from './inspectorModel';
import { colorSwatchValue, validateInspectorValue } from './propertyCatalog';
import { AssetPicker } from './AssetPicker';

export interface StylePropertyFieldProps {
  readonly field: InspectorStyleFieldModel;
  readonly draftContext: InspectorDraftContext;
  readonly projectAssets: readonly ProjectAsset[];
  readonly onEdit: (field: InspectorStyleFieldModel, value: string, token: InspectorContextToken, origin: HTMLElement) => void;
}

export function StylePropertyField({ field, draftContext, projectAssets, onEdit }: StylePropertyFieldProps) {
  const { definition } = field;
  const inputId = `inspector-style-${definition.property}`;
  const [draft, setDraft] = useState(field.value);
  const [error, setError] = useState<string | null>(null);
  const skipBlurCommit = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setDraft(field.value);
    setError(null);
  }, [draftContext, field.value, field.mixed]);

  const update = (value: string) => {
    setDraft(value);
    const validation = value.length === 0 ? null : validateInspectorValue(definition, value);
    setError(validation);
  };
  const commit = (value: string, origin: HTMLElement) => {
    const validation = validateInspectorValue(definition, value);
    setError(validation);
    if (validation === null && (field.mixed || value !== field.value)) onEdit(field, value, draftContext.token, origin);
  };
  const blur = (event: FocusEvent<HTMLInputElement>) => {
    if (skipBlurCommit.current) return;
    commit(event.currentTarget.value, event.currentTarget);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    skipBlurCommit.current = true;
    commit(event.currentTarget.value, event.currentTarget);
    queueMicrotask(() => { skipBlurCommit.current = false; });
  };
  const enumChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setDraft(value);
    setError(null);
    if (value.length > 0 && (field.mixed || value !== field.value)) onEdit(field, value, draftContext.token, event.currentTarget);
  };

  return (
    <div className="inspector-field" data-property={definition.property}>
      <label htmlFor={inputId}>{definition.label}</label>
      <div className="inspector-control">
        {definition.kind === 'enum'
          ? (
              <select id={inputId} aria-label={definition.label} value={draft} aria-invalid={error !== null} onChange={enumChange}>
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
                  ref={inputRef}
                  id={inputId}
                  aria-label={definition.label}
                  value={draft}
                  placeholder={field.mixed ? 'Mixed' : undefined}
                  aria-invalid={error !== null}
                  aria-describedby={`${inputId}-origin${error === null ? '' : ` ${inputId}-error`}`}
                  onChange={(event) => update(event.target.value)}
                  onBlur={blur}
                  onKeyDown={keyDown}
                />
                {definition.kind === 'asset' && (
                  <AssetPicker
                    label={definition.label}
                    assets={projectAssets}
                    valueKind="style"
                    resetKey={draftContext.key}
                    onSelect={(value) => {
                      setDraft(value);
                      setError(null);
                      if ((field.mixed || value !== field.value) && inputRef.current !== null) {
                        onEdit(field, value, draftContext.token, inputRef.current);
                      }
                    }}
                  />
                )}
              </div>
            )}
      </div>
      <span id={`${inputId}-origin`} className="inspector-origin" title={field.origin.title}>{field.mixed ? 'Mixed' : field.origin.label}</span>
      {error !== null && <span id={`${inputId}-error`} className="inspector-error" role="alert">{error}</span>}
    </div>
  );
}
