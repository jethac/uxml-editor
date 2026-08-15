import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ExternalChangeDecision } from '../../core/persistence/SaveCoordinator';
import type { FileWorkflow } from './FileWorkflow';

export interface ExternalChangeDialogProps {
  readonly workflow: FileWorkflow;
}

export function ExternalChangeDialog({ workflow }: ExternalChangeDialogProps) {
  const snapshot = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot, workflow.getSnapshot);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  useEffect(() => { firstAction.current?.focus(); }, [snapshot.externalChanges.length]);
  if (snapshot.externalChanges.length === 0) return null;
  const resolve = async (path: string, decision: ExternalChangeDecision) => {
    setBusyPath(path);
    try {
      await workflow.resolveExternalChange(path, decision);
    } finally {
      setBusyPath(null);
    }
  };

  return (
    <div className="command-dialog-backdrop">
      <section className="external-change-dialog" role="dialog" aria-modal="true" aria-label="External file changes">
        <header>
          <h2>External File Changes</h2>
        </header>
        <div className="external-change-list">
          {snapshot.externalChanges.map((change, index) => (
            <div className="external-change-row" key={change.path}>
              <div>
                <strong>{change.path}</strong>
                <span>{change.external === 'deleted' ? 'Deleted outside the editor' : 'Changed outside the editor'}</span>
              </div>
              <div className="external-change-actions">
                <button
                  ref={index === 0 ? firstAction : undefined}
                  type="button"
                  disabled={busyPath !== null}
                  aria-label={`Reload ${change.path} from disk`}
                  onClick={() => void resolve(change.path, 'reload')}
                >
                  Reload from Disk
                </button>
                <button
                  type="button"
                  disabled={busyPath !== null}
                  aria-label={`Overwrite ${change.path} on disk`}
                  onClick={() => void resolve(change.path, 'overwrite')}
                >
                  Keep Editor Version
                </button>
                <button
                  type="button"
                  disabled={busyPath !== null}
                  aria-label={`Dismiss ${change.path} external change`}
                  onClick={() => void resolve(change.path, 'cancel')}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
