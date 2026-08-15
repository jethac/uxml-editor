import { FolderSearch } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProjectAsset } from '../../core/store/ProjectAssetCatalog';

type AssetMode = 'path' | 'resource';

export interface AssetPickerProps {
  readonly label: string;
  readonly assets: readonly ProjectAsset[];
  readonly valueKind: 'style' | 'attribute';
  readonly resetKey: unknown;
  readonly onSelect: (value: string) => void;
}

export function AssetPicker({ label, assets, valueKind, resetKey, onSelect }: AssetPickerProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AssetMode>('path');
  const [selectedPath, setSelectedPath] = useState(assets[0]?.path ?? '');
  const available = mode === 'path' ? assets : assets.filter((asset) => asset.resourceKey !== undefined);
  useEffect(() => {
    setOpen(false);
    setMode('path');
    setSelectedPath(assets[0]?.path ?? '');
  }, [assets, resetKey]);
  useEffect(() => {
    if (!available.some((asset) => asset.path === selectedPath)) setSelectedPath(available[0]?.path ?? '');
  }, [available, selectedPath]);
  const chooseMode = (next: AssetMode) => {
    setMode(next);
    const candidates = next === 'path' ? assets : assets.filter((asset) => asset.resourceKey !== undefined);
    setSelectedPath(candidates[0]?.path ?? '');
  };
  const useAsset = () => {
    const asset = available.find((candidate) => candidate.path === selectedPath);
    if (asset === undefined) return;
    const value = formatAssetValue(asset, mode, valueKind);
    if (value === null) return;
    setOpen(false);
    onSelect(value);
  };

  return (
    <>
      <button
        type="button"
        aria-label={`Available ${label.toLowerCase()} values`}
        title="Choose project asset"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <FolderSearch aria-hidden="true" />
      </button>
      {open && (
        <div className="inspector-asset-picker" role="dialog" aria-label={`Choose ${label.toLowerCase()} asset`}>
          <fieldset>
            <legend>Asset reference mode</legend>
            <label><input type="radio" name={`${label}-asset-mode`} checked={mode === 'path'} onChange={() => chooseMode('path')} />Path / URL</label>
            <label><input type="radio" name={`${label}-asset-mode`} checked={mode === 'resource'} disabled={!assets.some((asset) => asset.resourceKey !== undefined)} onChange={() => chooseMode('resource')} />Resource</label>
          </fieldset>
          <select aria-label={`${label} project asset`} value={selectedPath} onChange={(event) => setSelectedPath(event.target.value)}>
            {available.map((asset) => <option key={asset.path} value={asset.path}>{asset.path}</option>)}
          </select>
          <div className="inspector-asset-picker__actions">
            <button type="button" disabled={selectedPath.length === 0} onClick={useAsset}>Use {label.toLowerCase()} asset</button>
            <button type="button" onClick={() => setOpen(false)}>Cancel asset selection</button>
          </div>
        </div>
      )}
    </>
  );
}

function formatAssetValue(asset: ProjectAsset, mode: AssetMode, valueKind: 'style' | 'attribute'): string | null {
  if (mode === 'path') return valueKind === 'style' ? `url("${asset.path}")` : asset.path;
  if (asset.resourceKey === undefined) return null;
  return valueKind === 'style' ? `resource("${asset.resourceKey}")` : `resource://${asset.resourceKey}`;
}
