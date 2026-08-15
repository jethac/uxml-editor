import type { InspectorStyleSectionProps } from './LayoutSection';
import { StylePropertyField } from './StylePropertyField';

export function TypographySection({ fields, onEdit }: InspectorStyleSectionProps) {
  return (
    <section className="inspector-section" aria-labelledby="inspector-typography-heading">
      <h3 id="inspector-typography-heading">Typography</h3>
      <div className="inspector-fields">{fields.map((field) => <StylePropertyField key={field.definition.property} field={field} onEdit={onEdit} />)}</div>
    </section>
  );
}
