import type { InspectorStyleFieldModel } from './inspectorModel';
import { StylePropertyField } from './StylePropertyField';

export interface InspectorStyleSectionProps {
  readonly fields: readonly InspectorStyleFieldModel[];
  readonly onEdit: (field: InspectorStyleFieldModel, value: string) => void;
}

export function LayoutSection({ fields, onEdit }: InspectorStyleSectionProps) {
  return (
    <section className="inspector-section" aria-labelledby="inspector-layout-heading">
      <h3 id="inspector-layout-heading">Layout</h3>
      <div className="inspector-fields">{fields.map((field) => <StylePropertyField key={field.definition.property} field={field} onEdit={onEdit} />)}</div>
    </section>
  );
}
