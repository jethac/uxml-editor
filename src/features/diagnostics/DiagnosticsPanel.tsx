import { useRef, useState, type KeyboardEvent } from 'react';
import { CircleAlert, Search } from 'lucide-react';
import type { EditorDiagnostic } from '../../core/adapter/types';
import type { SourceEditCoordinator } from '../../core/documents/SourceEditCoordinator';
import type { EditorStore } from '../../core/store/EditorStore';

export interface DiagnosticsPanelProps {
  readonly store: EditorStore;
  readonly coordinator: SourceEditCoordinator | null;
  readonly diagnostics: readonly EditorDiagnostic[];
  readonly onOpenSource: (path: string) => void;
}

export function DiagnosticsPanel({
  store,
  coordinator,
  diagnostics,
  onOpenSource,
}: DiagnosticsPanelProps) {
  const [query, setQuery] = useState('');
  const [file, setFile] = useState('all');
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const files = [...new Set(diagnostics.flatMap((diagnostic) => diagnostic.source?.path ?? []))].sort();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = diagnostics.filter((diagnostic) => {
    if (file !== 'all' && diagnostic.source?.path !== file) return false;
    return normalizedQuery.length === 0
      || diagnostic.message.toLocaleLowerCase().includes(normalizedQuery)
      || diagnostic.kind.toLocaleLowerCase().includes(normalizedQuery);
  });
  const groups = groupByFile(visible);
  rowRefs.current.length = visible.length;

  const activate = (diagnostic: EditorDiagnostic) => {
    const session = store.getSnapshot().session;
    if (session !== null && diagnostic.nodeId !== undefined) {
      const locator = session.locatorFor(diagnostic.nodeId);
      if (locator !== null) {
        session.setSelection([locator]);
        store.dispatch({ type: 'session/sync' });
      }
    }
    const source = diagnostic.source;
    if (source !== undefined && coordinator !== null && coordinator.activate(source.path, source)) {
      onOpenSource(source.path);
    }
  };
  const handleRowKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = Math.min(index + 1, visible.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = visible.length - 1;
    if (next === null) return;
    event.preventDefault();
    rowRefs.current[next]?.focus();
  };

  let visibleIndex = 0;
  return (
    <div className="diagnostics-panel">
      <div className="diagnostics-toolbar">
        <label className="diagnostics-search">
          <Search aria-hidden="true" size={13} />
          <span className="visually-hidden">Filter diagnostics</span>
          <input
            type="search"
            aria-label="Filter diagnostics"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          aria-label="Diagnostic file"
          value={file}
          onChange={(event) => setFile(event.target.value)}
        >
          <option value="all">All files</option>
          {files.map((path) => <option key={path} value={path}>{path}</option>)}
        </select>
        <output aria-label="Diagnostic count">{visible.length}</output>
      </div>
      <div className="diagnostics-results">
        {groups.map((group) => (
          <section className="diagnostic-group" key={group.path} aria-label={`${group.path} warnings`}>
            <h3>{group.path}</h3>
            <ul>
              {group.diagnostics.map((diagnostic) => {
                const index = visibleIndex;
                visibleIndex += 1;
                return (
                  <li key={`${diagnostic.kind}:${diagnostic.message}:${index}`}>
                    <button
                      ref={(element) => { rowRefs.current[index] = element; }}
                      type="button"
                      className="diagnostic-row"
                      aria-label={diagnosticRowLabel(diagnostic)}
                      onClick={() => activate(diagnostic)}
                      onKeyDown={(event) => handleRowKey(event, index)}
                    >
                      <CircleAlert aria-hidden="true" size={14} />
                      <span className="diagnostic-message">{diagnostic.message}</span>
                      <span className="diagnostic-location">{diagnosticLocation(diagnostic, coordinator)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {visible.length === 0 && <span className="pane-empty">No matching diagnostics</span>}
      </div>
    </div>
  );
}

interface DiagnosticGroup {
  readonly path: string;
  readonly diagnostics: readonly EditorDiagnostic[];
}

function groupByFile(diagnostics: readonly EditorDiagnostic[]): readonly DiagnosticGroup[] {
  const groups = new Map<string, EditorDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const path = diagnostic.source?.path ?? 'General';
    const existing = groups.get(path);
    if (existing === undefined) groups.set(path, [diagnostic]);
    else existing.push(diagnostic);
  }
  return [...groups].map(([path, items]) => ({ path, diagnostics: items }));
}

function diagnosticRowLabel(diagnostic: EditorDiagnostic): string {
  return `${diagnostic.message}, ${diagnostic.source?.path ?? 'General'}`;
}

function diagnosticLocation(diagnostic: EditorDiagnostic, coordinator: SourceEditCoordinator | null): string {
  const source = diagnostic.source;
  if (source === undefined) return diagnostic.kind;
  const text = coordinator?.getSnapshot().drafts.get(source.path);
  if (text === undefined || source.start < 0 || source.start > text.length) return diagnostic.kind;
  const line = text.slice(0, source.start).split(/\r\n|\r|\n/).length;
  return `${line}:${source.start - lineStart(text, source.start) + 1}`;
}

function lineStart(text: string, offset: number): number {
  const lf = text.lastIndexOf('\n', offset - 1);
  const cr = text.lastIndexOf('\r', offset - 1);
  return Math.max(lf, cr) + 1;
}
