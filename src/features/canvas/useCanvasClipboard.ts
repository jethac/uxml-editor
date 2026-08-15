import { useEffect, useMemo, useRef } from 'react';
import type { EditorElement } from '../../core/adapter/types';
import {
  ClipboardService,
  type ClipboardItemLike,
  type ClipboardPasteResult,
  type ClipboardPort,
} from '../../core/commands/ClipboardService';
import type { DocumentSession } from '../../core/documents/DocumentSession';
import type { EditorStore } from '../../core/store/EditorStore';

interface UseCanvasClipboardOptions {
  readonly store: EditorStore;
  readonly session: DocumentSession | null;
  readonly selectedNodes: readonly EditorElement[];
  readonly clipboardPort?: ClipboardPort;
  readonly onDiagnostic: (message: string | null) => void;
  readonly onCommit: (session: DocumentSession) => void;
}

interface CanvasClipboardActions {
  readonly copy: () => Promise<void>;
  readonly paste: () => Promise<void>;
  readonly duplicate: () => Promise<void>;
}

export function useCanvasClipboard({
  store,
  session,
  selectedNodes,
  clipboardPort,
  onDiagnostic,
  onCommit,
}: UseCanvasClipboardOptions): CanvasClipboardActions {
  const service = useMemo(
    () => new ClipboardService(clipboardPort ?? browserClipboardPort()),
    [clipboardPort],
  );
  const fallbackRef = useRef<{ readonly session: DocumentSession; readonly item: ClipboardItemLike } | null>(null);

  useEffect(() => {
    if (fallbackRef.current?.session !== session) fallbackRef.current = null;
  }, [session]);

  const currentSessionIs = (initiatingSession: DocumentSession): boolean =>
    store.getSnapshot().session === initiatingSession;

  const execute = (initiatingSession: DocumentSession, result: ClipboardPasteResult): void => {
    if (!currentSessionIs(initiatingSession)) return;
    if (!result.ok) {
      onDiagnostic(result.diagnostic.message);
      return;
    }
    try {
      initiatingSession.history.execute(result.transaction);
      if (!currentSessionIs(initiatingSession)) return;
      onDiagnostic(null);
      onCommit(initiatingSession);
    } catch (error) {
      if (currentSessionIs(initiatingSession)) onDiagnostic(errorMessage(error));
    }
  };

  return {
    copy: async () => {
      const initiatingSession = session;
      const requested = [...selectedNodes];
      if (initiatingSession === null || requested.length === 0) return;
      const copied = service.copy(initiatingSession, requested);
      if (!currentSessionIs(initiatingSession)) return;
      if (!copied.ok) {
        onDiagnostic(copied.diagnostic.message);
        return;
      }
      fallbackRef.current = { session: initiatingSession, item: copied.item };
      const written = await service.writeCopy(initiatingSession, requested);
      if (!currentSessionIs(initiatingSession)) return;
      onDiagnostic(written.ok || written.diagnostic.code === 'CLIPBOARD_IO_FAILED'
        ? null
        : written.diagnostic.message);
    },
    paste: async () => {
      const initiatingSession = session;
      if (initiatingSession === null) return;
      const parent = selectedNodes[0] ?? initiatingSession.document.root;
      const parentLocator = initiatingSession.locatorFor(parent.id);
      if (parentLocator === null) return;
      const fallback = fallbackRef.current?.session === initiatingSession
        ? fallbackRef.current.item
        : undefined;
      const read = await service.readItem(fallback);
      if (!currentSessionIs(initiatingSession)) return;
      if (!read.ok) {
        onDiagnostic(read.diagnostic.message);
        return;
      }
      const result = await service.paste(
        initiatingSession,
        parentLocator,
        parent.children.length,
        read.item,
      );
      if (!currentSessionIs(initiatingSession)) return;
      execute(initiatingSession, result);
    },
    duplicate: async () => {
      const initiatingSession = session;
      const requested = [...selectedNodes];
      if (initiatingSession === null || requested.length === 0) return;
      const result = await service.duplicate(initiatingSession, requested);
      if (!currentSessionIs(initiatingSession)) return;
      execute(initiatingSession, result);
    },
  };
}

function browserClipboardPort(): ClipboardPort | undefined {
  if (
    typeof navigator === 'undefined'
    || navigator.clipboard === undefined
    || typeof navigator.clipboard.write !== 'function'
    || typeof navigator.clipboard.read !== 'function'
    || typeof ClipboardItem === 'undefined'
  ) return undefined;
  return {
    write: async (items) => {
      const browserItems: ClipboardItem[] = [];
      for (const item of items) {
        const data: Record<string, Blob> = {};
        for (const type of item.types) {
          const blob = await item.getType(type);
          data[type] = blob instanceof Blob ? blob : new Blob([await blob.text()], { type });
        }
        browserItems.push(new ClipboardItem(data));
      }
      await navigator.clipboard.write(browserItems);
    },
    read: async () => navigator.clipboard.read(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'Clipboard operation failed.';
}
