import type { InspectorStyleSectionProps } from './LayoutSection';
import { StylePropertyField } from './StylePropertyField';

export function AppearanceSection({ fields, onEdit }: InspectorStyleSectionProps) {
  return (
    <section className="inspector-section" aria-labelledby="inspector-appearance-heading">
      <h3 id="inspector-appearance-heading">Appearance</h3>
      <div className="inspector-fields">{fields.map((field) => <StylePropertyField key={field.definition.property} field={field} onEdit={onEdit} />)}</div>
    </section>
  );
}
