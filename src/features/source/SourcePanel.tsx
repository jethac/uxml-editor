import { useEffect, useRef, useSyncExternalStore, type ChangeEvent } from 'react';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { EditorState } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { xml } from '@codemirror/lang-xml';
import { css } from '@codemirror/lang-css';
import type { EditorDiagnostic, EditorSourceSpan } from '../../core/adapter/types';
import type { SourceEditCoordinator } from '../../core/documents/SourceEditCoordinator';

export interface SourcePanelProps {
  readonly coordinator: SourceEditCoordinator;
  readonly diagnostics: readonly EditorDiagnostic[];
}

export function SourcePanel({ coordinator, diagnostics }: SourcePanelProps) {
  const snapshot = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
  const hostRef = useRef<HTMLDivElement>(null);
  const fileControlRef = useRef<HTMLSelectElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const synchronizingRef = useRef(false);
  const draftsRef = useRef(snapshot.drafts);
  draftsRef.current = snapshot.drafts;
  const diagnosticSources = navigableDiagnostics(diagnostics, snapshot.drafts);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const path = snapshot.activePath;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: snapshot.drafts.get(path) ?? '',
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          history(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          search({ top: true }),
          keymap.of([
            {
              key: 'Escape',
              run: () => {
                fileControlRef.current?.focus();
                return true;
              },
            },
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...defaultKeymap,
          ]),
          path.toLowerCase().endsWith('.uss') ? css() : xml(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !synchronizingRef.current) {
              const source = draftsRef.current.get(path) ?? '';
              const changes: EditorTextChange[] = [];
              update.changes.iterChanges((from, to, _fromAfter, _toAfter, inserted) => {
                changes.push({ from, to, insert: inserted.toString() });
              });
              const replacement = applyEditorChanges(source, changes);
              const drafts = new Map(draftsRef.current);
              drafts.set(path, replacement);
              draftsRef.current = drafts;
              coordinator.replace(replacement);
            }
          }),
        ],
      }),
    });
    view.contentDOM.setAttribute('aria-label', `${path} source`);
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [coordinator, snapshot.activePath]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const draft = snapshot.drafts.get(snapshot.activePath) ?? '';
    const editorDraft = normalizeEditorLineEndings(draft);
    const current = view.state.doc.toString();
    const span = spanForActiveFile(snapshot.activeSpan, snapshot.activePath, draft.length);
    const effects = span === null ? undefined : EditorView.scrollIntoView(span.start, { y: 'center' });
    if (current === editorDraft && span === null) return;
    synchronizingRef.current = true;
    try {
      view.dispatch({
        ...(current === editorDraft ? {} : { changes: { from: 0, to: current.length, insert: editorDraft } }),
        ...(span === null ? {} : { selection: { anchor: span.start, head: span.end }, effects }),
      });
    } finally {
      synchronizingRef.current = false;
    }
  }, [snapshot.activePath, snapshot.activeSpan, snapshot.drafts]);

  const changeFile = (event: ChangeEvent<HTMLSelectElement>) => {
    coordinator.activate(event.target.value);
  };
  const navigateDiagnostic = (direction: -1 | 1) => {
    if (diagnosticSources.length === 0) return;
    const currentIndex = diagnosticSources.findIndex((source) => sameSpan(source, snapshot.activeSpan));
    const nextIndex = currentIndex === -1
      ? direction === 1 ? 0 : diagnosticSources.length - 1
      : (currentIndex + direction + diagnosticSources.length) % diagnosticSources.length;
    const target = diagnosticSources[nextIndex];
    coordinator.activate(target.path, target);
  };

  return (
    <div className="source-panel">
      <div className="source-toolbar" role="toolbar" aria-label="Source tools">
        <label className="source-file-control">
          <span className="visually-hidden">Source file</span>
          <select
            ref={fileControlRef}
            aria-label="Source file"
            value={snapshot.activePath}
            onChange={changeFile}
          >
            {[...snapshot.drafts.keys()].map((path) => <option key={path} value={path}>{path}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="source-tool-button"
          aria-label="Find in source"
          title="Find in source"
          onClick={() => openSearchPanel(viewRef.current!)}
        >
          <Search aria-hidden="true" size={14} />
        </button>
        <button
          type="button"
          className="source-tool-button"
          aria-label="Previous diagnostic"
          title="Previous diagnostic"
          disabled={diagnosticSources.length === 0}
          onClick={() => navigateDiagnostic(-1)}
        >
          <ChevronUp aria-hidden="true" size={14} />
        </button>
        <button
          type="button"
          className="source-tool-button"
          aria-label="Next diagnostic"
          title="Next diagnostic"
          disabled={diagnosticSources.length === 0}
          onClick={() => navigateDiagnostic(1)}
        >
          <ChevronDown aria-hidden="true" size={14} />
        </button>
        <output className={`source-status source-status--${snapshot.status}`} aria-live="polite">
          {snapshot.status === 'stale' ? 'Preview stale' : 'Ready'}
        </output>
      </div>
      <div
        ref={hostRef}
        className="source-editor"
        data-testid="source-editor"
        data-language={sourceLanguage(snapshot.activePath)}
      />
    </div>
  );
}

function sourceLanguage(path: string): 'css' | 'xml' {
  return path.toLowerCase().endsWith('.uss') ? 'css' : 'xml';
}

function navigableDiagnostics(
  diagnostics: readonly EditorDiagnostic[],
  drafts: ReadonlyMap<string, string>,
): readonly EditorSourceSpan[] {
  return diagnostics.flatMap((diagnostic) => {
    const source = diagnostic.source;
    const length = source === undefined ? undefined : drafts.get(source.path)?.length;
    return source === undefined || length === undefined || !validSpan(source, length) ? [] : [source];
  });
}

function spanForActiveFile(span: EditorSourceSpan | null, path: string, length: number): EditorSourceSpan | null {
  return span !== null && span.path === path && validSpan(span, length) ? span : null;
}

function validSpan(span: Readonly<{ start: number; end: number }>, length: number): boolean {
  return span.start >= 0 && span.end >= span.start && span.end <= length;
}

function sameSpan(left: EditorSourceSpan, right: EditorSourceSpan | null): boolean {
  return right !== null
    && left.path === right.path
    && left.start === right.start
    && left.end === right.end;
}

interface EditorTextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

function applyEditorChanges(source: string, changes: readonly EditorTextChange[]): string {
  const mapped = changes.map((change) => ({
    from: editorOffsetToSourceOffset(source, change.from),
    to: editorOffsetToSourceOffset(source, change.to),
    insert: change.insert,
  }));
  let result = source;
  for (let index = mapped.length - 1; index >= 0; index -= 1) {
    const change = mapped[index]!;
    result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  }
  return result;
}

function editorOffsetToSourceOffset(source: string, target: number): number {
  let sourceOffset = 0;
  let editorOffset = 0;
  while (sourceOffset < source.length && editorOffset < target) {
    sourceOffset += source[sourceOffset] === '\r' && source[sourceOffset + 1] === '\n' ? 2 : 1;
    editorOffset += 1;
  }
  if (editorOffset !== target) throw new RangeError(`Editor offset is outside the source: ${target}`);
  return sourceOffset;
}

function normalizeEditorLineEndings(source: string): string {
  return source.replace(/\r\n?/g, '\n');
}
