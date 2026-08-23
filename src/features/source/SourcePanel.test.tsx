import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { UxmlPreviewAdapter } from '../../core/adapter/UxmlPreviewAdapter';
import type { EditorDiagnostic } from '../../core/adapter/types';
import { DocumentSession } from '../../core/documents/DocumentSession';
import { SourceEditCoordinator } from '../../core/documents/SourceEditCoordinator';
import { SourcePanel } from './SourcePanel';

const entryPath = 'Assets/UI/Main.uxml';
const sheetPath = 'Assets/UI/Main.uss';
const uxml = `<ui:UXML xmlns:ui="UnityEngine.UIElements">
  <Style src="Assets/UI/Main.uss" />
  <ui:Label name="title" text="Original" />
</ui:UXML>\n`;
const uss = '.title { color: red; }\n';
const coordinators: SourceEditCoordinator[] = [];

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
});

describe('SourcePanel', () => {
  it('renders CodeMirror directly and preserves independent XML and CSS drafts while switching files', async () => {
    const user = userEvent.setup();
    const coordinator = createCoordinator();
    render(<SourcePanel coordinator={coordinator} diagnostics={[]} />);

    expect(screen.getByRole('textbox', { name: `${entryPath} source` })).toHaveTextContent('Original');
    expect(screen.getByTestId('source-editor')).toHaveAttribute('data-language', 'xml');

    act(() => coordinator.replace(uxml.replace('Original', 'Draft')));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Source file' }), sheetPath);
    expect(screen.getByRole('textbox', { name: `${sheetPath} source` }).textContent).toContain('.title { color: red; }');
    expect(screen.getByTestId('source-editor')).toHaveAttribute('data-language', 'css');

    act(() => coordinator.replace(uss.replace('red', 'blue')));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Source file' }), entryPath);
    expect(screen.getByRole('textbox', { name: `${entryPath} source` })).toHaveTextContent('Draft');
    expect(coordinator.getSnapshot().drafts.get(sheetPath)).toContain('blue');
  });

  it('opens source find, navigates diagnostic spans, and transfers Escape focus to the file control', async () => {
    const user = userEvent.setup();
    const coordinator = createCoordinator();
    const diagnostics: readonly EditorDiagnostic[] = [
      diagnostic(entryPath, 47, 52, 'Entry warning'),
      diagnostic(sheetPath, 16, 19, 'Style warning'),
    ];
    render(<SourcePanel coordinator={coordinator} diagnostics={diagnostics} />);

    await user.click(screen.getByRole('button', { name: 'Find in source' }));
    expect(await screen.findByRole('textbox', { name: 'Find' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Next diagnostic' }));
    await user.click(screen.getByRole('button', { name: 'Next diagnostic' }));
    expect(coordinator.getSnapshot()).toMatchObject({
      activePath: sheetPath,
      activeSpan: { path: sheetPath, start: 16, end: 19 },
    });

    const editor = await screen.findByRole('textbox', { name: `${sheetPath} source` });
    editor.focus();
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Source file' })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Previous diagnostic' }));
    expect(coordinator.getSnapshot().activePath).toBe(entryPath);
  });

  it('publishes real CodeMirror document changes to the immediate coordinator draft', () => {
    const coordinator = createCoordinator();
    render(<SourcePanel coordinator={coordinator} diagnostics={[]} />);
    const editor = screen.getByRole('textbox', { name: `${entryPath} source` });
    const view = EditorView.findFromDOM(editor);
    expect(view).not.toBeNull();

    act(() => view!.dispatch({
      changes: { from: 0, to: view!.state.doc.length, insert: uxml.replace('Original', 'Typed') },
    }));

    expect(coordinator.getSnapshot().drafts.get(entryPath)).toContain('Typed');
  });

  it('preserves exact CRLF bytes outside a localized visible source edit', () => {
    const crlfUxml = uxml.replace(/\n/g, '\r\n');
    const coordinator = createCoordinator(crlfUxml);
    render(<SourcePanel coordinator={coordinator} diagnostics={[]} />);
    const editor = screen.getByRole('textbox', { name: `${entryPath} source` });
    const view = EditorView.findFromDOM(editor)!;
    const from = view.state.doc.toString().indexOf('Original');

    act(() => view.dispatch({
      changes: { from, to: from + 'Original'.length, insert: 'Typed' },
    }));

    expect(coordinator.getSnapshot().drafts.get(entryPath)).toBe(crlfUxml.replace('Original', 'Typed'));
  });

  it('preserves untouched mixed separators across a localized visible source edit', async () => {
    const user = userEvent.setup();
    const mixedUss = '.title {\r\n  color: red;\n  width: 10px;\r}\r\n';
    const coordinator = createCoordinator(uxml, mixedUss);
    render(<SourcePanel coordinator={coordinator} diagnostics={[]} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Source file' }), sheetPath);
    const editor = screen.getByRole('textbox', { name: `${sheetPath} source` });
    const view = EditorView.findFromDOM(editor)!;
    const from = view.state.doc.toString().indexOf('red');

    act(() => view.dispatch({
      changes: { from, to: from + 'red'.length, insert: 'blue' },
    }));

    expect(coordinator.getSnapshot().drafts.get(sheetPath)).toBe(mixedUss.replace('red', 'blue'));
  });

  it('maps rapid localized edits against the latest exact CRLF draft', () => {
    const crlfUxml = uxml.replace(/\n/g, '\r\n');
    const coordinator = createCoordinator(crlfUxml);
    render(<SourcePanel coordinator={coordinator} diagnostics={[]} />);
    const editor = screen.getByRole('textbox', { name: `${entryPath} source` });
    const view = EditorView.findFromDOM(editor)!;

    act(() => {
      const first = view.state.doc.toString().indexOf('Assets/UI/Main.uss');
      view.dispatch({ changes: { from: first, to: first + 'Assets/UI/Main.uss'.length, insert: 'M.uss' } });
      const second = view.state.doc.toString().indexOf('Original');
      view.dispatch({ changes: { from: second, to: second + 'Original'.length, insert: 'Typed' } });
    });

    expect(coordinator.getSnapshot().drafts.get(entryPath)).toBe(
      crlfUxml.replace('Assets/UI/Main.uss', 'M.uss').replace('Original', 'Typed'),
    );
  });
});

function createCoordinator(entrySource = uxml, sheetSource = uss): SourceEditCoordinator {
  const session = DocumentSession.open(new Map([
    [entryPath, entrySource],
    [sheetPath, sheetSource],
  ]), entryPath, new UxmlPreviewAdapter());
  const coordinator = new SourceEditCoordinator(session);
  coordinators.push(coordinator);
  return coordinator;
}

function diagnostic(path: string, start: number, end: number, message: string): EditorDiagnostic {
  return {
    origin: 'parse',
    severity: 'warning',
    kind: 'unsupported-property',
    message,
    source: { path, start, end },
  };
}
