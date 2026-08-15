import type { InspectorStyleFieldModel } from './inspectorModel';
import { StylePropertyField } from './StylePropertyField';
import type { ProjectAsset } from '../../core/store/ProjectAssetCatalog';

export interface InspectorStyleSectionProps {
  readonly fields: readonly InspectorStyleFieldModel[];
  readonly draftContext: unknown;
  readonly projectAssets: readonly ProjectAsset[];
  readonly onEdit: (field: InspectorStyleFieldModel, value: string) => void;
}

export function LayoutSection({ fields, draftContext, projectAssets, onEdit }: InspectorStyleSectionProps) {
  return (
    <section className="inspector-section" aria-labelledby="inspector-layout-heading">
      <h3 id="inspector-layout-heading">Layout</h3>
      <div className="inspector-fields">{fields.map((field) => <StylePropertyField key={field.definition.property} field={field} draftContext={draftContext} projectAssets={projectAssets} onEdit={onEdit} />)}</div>
    </section>
  );
}
