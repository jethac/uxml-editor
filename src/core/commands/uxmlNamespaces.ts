import type { EditorElement } from '../adapter/types';
import { decodeXmlAttributeValue, isQualifiedXmlName } from './xmlFormatting';
import { UxmlCommandError } from './uxmlCommandError';
import { lineageTo } from './uxmlTree';

export function namespaceBindingsAt(
  root: EditorElement,
  target: EditorElement,
): ReadonlyMap<string, string> {
  const lineage = lineageTo(root, target);
  if (lineage === null) {
    throw new UxmlCommandError('ambiguous-source', `${target.name} is absent from the document tree.`);
  }
  let bindings = new Map<string, string>([
    ['xml', 'http://www.w3.org/XML/1998/namespace'],
  ]);
  for (const element of lineage) {
    const scoped = withNamespaceDeclarations(bindings, element);
    if (scoped === null) {
      throw new UxmlCommandError(
        'ambiguous-source',
        `The namespace declarations in scope for ${target.name} are not safe to interpret.`,
      );
    }
    bindings = scoped;
  }
  return bindings;
}

export function requireSafeNamespaceRemoval(
  root: EditorElement,
  element: EditorElement,
  attributeName: string,
  authoredValue: string,
): void {
  const prefix = attributeName === 'xmlns' ? '' : attributeName.slice('xmlns:'.length);
  const removedUri = decodeXmlAttributeValue(authoredValue);
  if (removedUri === null || !isUsableNamespaceBinding(prefix, removedUri)) {
    throw new UxmlCommandError(
      'ambiguous-source',
      `Namespace declaration ${attributeName} is not safe to interpret.`,
    );
  }
  const inherited = namespaceBindingsBefore(root, element);
  const inheritedUri = prefix.length === 0 ? inherited.get(prefix) ?? '' : inherited.get(prefix);
  if (inheritedUri === removedUri) return;
  if (subtreeDependsOnNamespace(element, prefix, true)) {
    throw new UxmlCommandError(
      'illegal-hierarchy',
      `Removing ${attributeName} would change or unbind a QName in ${element.name}.`,
    );
  }
}

export function requireAttributeNamespace(
  root: EditorElement,
  element: EditorElement,
  name: string,
  value: string,
): void {
  if (name === 'xmlns') {
    if (isReservedNamespaceUri(value)) {
      throw new UxmlCommandError('invalid-value', 'The default namespace cannot use a reserved namespace URI.');
    }
    return;
  }
  if (name.startsWith('xmlns:')) {
    const prefix = name.slice('xmlns:'.length);
    if (prefix === 'xmlns') {
      throw new UxmlCommandError('invalid-name', 'The xmlns prefix cannot itself be declared.');
    }
    if (prefix === 'xml') {
      if (value !== 'http://www.w3.org/XML/1998/namespace') {
        throw new UxmlCommandError('invalid-value', 'The xml prefix must use the XML namespace URI.');
      }
      return;
    }
    if (value.length === 0 || isReservedNamespaceUri(value)) {
      throw new UxmlCommandError(
        'invalid-value',
        `Namespace prefix ${prefix} requires a non-reserved, non-empty namespace URI.`,
      );
    }
    return;
  }
  requireBoundQName(root, element, name, true);
}

export function requireBoundQName(
  root: EditorElement,
  context: EditorElement,
  qualifiedName: string,
  attribute: boolean,
): void {
  const bindings = namespaceBindingsAt(root, context);
  if (resolvedNamespace(qualifiedName, attribute, bindings) === null) {
    throw new UxmlCommandError(
      'illegal-hierarchy',
      `Namespace prefix in ${qualifiedName} is not bound at ${context.name}.`,
    );
  }
}

export function preservesNamespaceSemantics(
  element: EditorElement,
  sourceBindings: ReadonlyMap<string, string>,
  destinationBindings: ReadonlyMap<string, string>,
): boolean {
  const sourceScope = withNamespaceDeclarations(sourceBindings, element);
  const destinationScope = withNamespaceDeclarations(destinationBindings, element);
  if (sourceScope === null || destinationScope === null) return false;
  const sourceNamespace = resolvedNamespace(element.name, false, sourceScope);
  const destinationNamespace = resolvedNamespace(element.name, false, destinationScope);
  if (
    sourceNamespace === null
    || destinationNamespace === null
    || sourceNamespace !== destinationNamespace
  ) {
    return false;
  }
  for (const attribute of element.attributes) {
    if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) continue;
    const sourceNamespace = resolvedNamespace(attribute.name, true, sourceScope);
    const destinationNamespace = resolvedNamespace(attribute.name, true, destinationScope);
    if (sourceNamespace === null || sourceNamespace !== destinationNamespace) return false;
  }
  return element.children.every((child) =>
    preservesNamespaceSemantics(child, sourceScope, destinationScope),
  );
}

function namespaceBindingsBefore(
  root: EditorElement,
  target: EditorElement,
): ReadonlyMap<string, string> {
  const lineage = lineageTo(root, target);
  if (lineage === null) {
    throw new UxmlCommandError('ambiguous-source', `${target.name} is absent from the document tree.`);
  }
  let bindings = new Map<string, string>([
    ['xml', 'http://www.w3.org/XML/1998/namespace'],
  ]);
  for (const element of lineage.slice(0, -1)) {
    const scoped = withNamespaceDeclarations(bindings, element);
    if (scoped === null) {
      throw new UxmlCommandError(
        'ambiguous-source',
        `The namespace declarations above ${target.name} are not safe to interpret.`,
      );
    }
    bindings = scoped;
  }
  return bindings;
}

function subtreeDependsOnNamespace(
  element: EditorElement,
  prefix: string,
  declarationOwner: boolean,
): boolean {
  if (!declarationOwner) {
    const declarationName = prefix.length === 0 ? 'xmlns' : `xmlns:${prefix}`;
    const overrides = element.attributes.filter((attribute) => attribute.name === declarationName);
    if (overrides.length > 1) {
      throw new UxmlCommandError('ambiguous-source', `${declarationName} occurs more than once on ${element.name}.`);
    }
    if (overrides.length === 1) {
      const overrideUri = decodeXmlAttributeValue(overrides[0].value);
      if (overrideUri === null || !isUsableNamespaceBinding(prefix, overrideUri)) {
        throw new UxmlCommandError(
          'ambiguous-source',
          `Nested namespace declaration ${declarationName} is not safe to interpret.`,
        );
      }
      return false;
    }
  }

  if (qNameUsesNamespacePrefix(element.name, prefix, false)) return true;
  if (element.attributes.some((attribute) =>
    attribute.name !== 'xmlns'
    && !attribute.name.startsWith('xmlns:')
    && qNameUsesNamespacePrefix(attribute.name, prefix, true),
  )) {
    return true;
  }
  return element.children.some((child) => subtreeDependsOnNamespace(child, prefix, false));
}

function qNameUsesNamespacePrefix(name: string, prefix: string, attribute: boolean): boolean {
  const colon = name.indexOf(':');
  if (prefix.length === 0) return !attribute && colon < 0;
  return colon === prefix.length && name.slice(0, colon) === prefix;
}

function isUsableNamespaceBinding(prefix: string, uri: string): boolean {
  if (prefix === 'xmlns') return false;
  if (prefix === 'xml') return uri === 'http://www.w3.org/XML/1998/namespace';
  if (prefix.length === 0) return !isReservedNamespaceUri(uri);
  return uri.length > 0 && !isReservedNamespaceUri(uri);
}

function withNamespaceDeclarations(
  inherited: ReadonlyMap<string, string>,
  element: EditorElement,
): Map<string, string> | null {
  const scoped = new Map(inherited);
  const declaredPrefixes = new Set<string>();
  for (const attribute of element.attributes) {
    const prefix = attribute.name === 'xmlns'
      ? ''
      : attribute.name.startsWith('xmlns:')
        ? attribute.name.slice('xmlns:'.length)
        : null;
    if (prefix === null) continue;
    if (declaredPrefixes.has(prefix)) return null;
    declaredPrefixes.add(prefix);
    const namespaceUri = decodeXmlAttributeValue(attribute.value);
    if (attribute.name === 'xmlns') {
      if (namespaceUri === null || isReservedNamespaceUri(namespaceUri)) return null;
      scoped.set('', namespaceUri);
      continue;
    }
    if (namespaceUri === null) return null;
    if (!isQualifiedXmlName(prefix) || prefix.includes(':') || prefix === 'xmlns') return null;
    if (prefix === 'xml') {
      if (namespaceUri !== 'http://www.w3.org/XML/1998/namespace') return null;
    } else if (namespaceUri.length === 0 || isReservedNamespaceUri(namespaceUri)) {
      return null;
    }
    scoped.set(prefix, namespaceUri);
  }
  return scoped;
}

function resolvedNamespace(
  qualifiedName: string,
  attribute: boolean,
  bindings: ReadonlyMap<string, string>,
): string | null {
  if (!isQualifiedXmlName(qualifiedName)) return null;
  const colon = qualifiedName.indexOf(':');
  if (colon < 0) return attribute ? '' : bindings.get('') ?? '';
  const prefix = qualifiedName.slice(0, colon);
  if (prefix === 'xmlns') return null;
  return bindings.get(prefix) ?? null;
}

function isReservedNamespaceUri(value: string): boolean {
  return value === 'http://www.w3.org/XML/1998/namespace'
    || value === 'http://www.w3.org/2000/xmlns/';
}
