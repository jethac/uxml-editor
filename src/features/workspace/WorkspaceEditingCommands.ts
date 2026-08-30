import type { EditorElement } from '../../core/adapter/types';
import {
  ClipboardService,
  type ClipboardItemLike,
} from '../../core/commands/ClipboardService';
import { removeElement } from '../../core/commands/uxmlCommands';
import { walkElements } from '../../core/commands/uxmlTree';
import type { DocumentSession } from '../../core/documents/DocumentSession';
import type { EditorEditingCommandPort } from '../../core/store/CommandRegistry';
import type { EditorStore } from '../../core/store/EditorStore';
import { browserClipboardPort } from '../canvas/useCanvasClipboard';

export class WorkspaceEditingCommands implements EditorEditingCommandPort {
  private readonly clipboard = new ClipboardService(browserClipboardPort());
  private fallback: Readonly<{ session: DocumentSession; item: ClipboardItemLike }> | null = null;

  constructor(private readonly store: EditorStore) {}

  canCut(): boolean { return this.canRemoveSelection(); }
  canCopy(): boolean { return this.selectedElements().length > 0; }
  canPaste(): boolean { return this.store.getSnapshot().session !== null; }
  canDuplicate(): boolean { return this.canRemoveSelection(); }
  canDelete(): boolean { return this.canRemoveSelection(); }

  async copy(): Promise<void> {
    const session = this.store.getSnapshot().session;
    if (session === null) return;
    const selected = this.selectedElements(session);
    if (selected.length === 0) return;
    const copied = this.clipboard.copy(session, selected);
    if (!copied.ok || this.store.getSnapshot().session !== session) return;
    this.fallback = Object.freeze({ session, item: copied.item });
    await this.clipboard.writeCopy(session, selected);
  }

  async cut(): Promise<void> {
    const session = this.store.getSnapshot().session;
    const selected = session === null ? [] : this.selectedElements(session);
    if (session === null || selected.length !== 1 || selected[0] === session.document.root) return;
    const generation = session.generation;
    await this.copy();
    if (this.store.getSnapshot().session !== session || session.generation !== generation) return;
    this.remove(session, selected[0]);
  }

  async paste(): Promise<void> {
    const session = this.store.getSnapshot().session;
    if (session === null) return;
    const generation = session.generation;
    const selected = this.selectedElements(session);
    const parent = selected[0] ?? session.document.root;
    const parentLocator = session.locatorFor(parent.id);
    if (parentLocator === null) return;
    const read = await this.clipboard.readItem(this.fallback?.session === session ? this.fallback.item : undefined);
    if (!read.ok || this.store.getSnapshot().session !== session || session.generation !== generation) return;
    const result = await this.clipboard.paste(session, parentLocator, parent.children.length, read.item);
    if (!result.ok || this.store.getSnapshot().session !== session || session.generation !== generation) return;
    session.history.execute(result.transaction);
    this.store.dispatch({ type: 'session/sync' });
  }

  async duplicate(): Promise<void> {
    const session = this.store.getSnapshot().session;
    const selected = session === null ? [] : this.selectedElements(session);
    if (session === null || selected.length !== 1 || selected[0] === session.document.root) return;
    const generation = session.generation;
    const result = await this.clipboard.duplicate(session, selected);
    if (!result.ok || this.store.getSnapshot().session !== session || session.generation !== generation) return;
    session.history.execute(result.transaction);
    this.store.dispatch({ type: 'session/sync' });
  }

  async delete(): Promise<void> {
    const session = this.store.getSnapshot().session;
    const selected = session === null ? [] : this.selectedElements(session);
    if (session === null || selected.length !== 1 || selected[0] === session.document.root) return;
    this.remove(session, selected[0]);
  }

  private canRemoveSelection(): boolean {
    const session = this.store.getSnapshot().session;
    const selected = session === null ? [] : this.selectedElements(session);
    return session !== null && selected.length === 1 && selected[0] !== session.document.root;
  }

  private selectedElements(session = this.store.getSnapshot().session): readonly EditorElement[] {
    if (session === null) return Object.freeze([]);
    const byId = new Map(walkElements(session.document.root).map((element) => [element.id, element]));
    return Object.freeze(session.selectedNodeIds.flatMap((id) => {
      const element = byId.get(id);
      return element === undefined ? [] : [element];
    }));
  }

  private remove(session: DocumentSession, element: EditorElement): void {
    const locator = session.locatorFor(element.id);
    if (locator === null || this.store.getSnapshot().session !== session) return;
    session.history.execute(removeElement(session, locator));
    this.store.dispatch({ type: 'session/sync' });
  }
}
