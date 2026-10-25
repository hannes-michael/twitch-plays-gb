import { useEffect, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import type { EmulatorStatus } from '@shared/emulator-status';
import type { RomImportResponse, RomListResponse, RomMetadata } from '@shared/roms';
import { normalizeTwitchChannel, type SettingsResponse } from '@shared/settings';

const MAX_CHANNEL_HINT = 'Enter a valid Twitch channel (2–25 letters, numbers, or underscores).';

interface SetupWizardProps {
  initialChannel: string | null;
  initialRomId: string | null;
  cancelable: boolean;
  onCancel: () => void;
  onComplete: (settings: SettingsResponse, status: EmulatorStatus | null, notice?: string) => void;
}

interface EmulatorOperationBody {
  status?: EmulatorStatus;
  error?: string;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const value = (body as { error?: unknown }).error;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return fallback;
}

export default function SetupWizard({
  initialChannel,
  initialRomId,
  cancelable,
  onCancel,
  onComplete,
}: SetupWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [channel, setChannel] = useState(initialChannel ?? '');
  const [channelError, setChannelError] = useState<string | null>(null);
  const [roms, setRoms] = useState<RomMetadata[]>([]);
  const [romsLoaded, setRomsLoaded] = useState(false);
  const [romsError, setRomsError] = useState<string | null>(null);
  const [selectedRomId, setSelectedRomId] = useState<string | null>(initialRomId);
  const [uploading, setUploading] = useState(false);
  const [romError, setRomError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const loadRoms = async (): Promise<void> => {
      try {
        const response = await fetch('/api/roms', { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as RomListResponse;
        if (active) setRoms(body.roms);
      } catch {
        if (active) setRomsError('Could not load the imported ROMs.');
      } finally {
        if (active) setRomsLoaded(true);
      }
    };

    void loadRoms();
    return () => {
      active = false;
    };
  }, []);

  const selectedRom = roms.find((rom) => rom.id === selectedRomId) ?? null;

  const uploadRom = async (file: File): Promise<void> => {
    setUploading(true);
    setRomError(null);
    setImportNotice(null);

    try {
      const response = await fetch('/api/roms', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': file.name,
          accept: 'application/json',
        },
        body: file,
      });
      const body = (await response.json().catch(() => null)) as
        (RomImportResponse & { error?: string }) | null;

      if (!response.ok || !body?.rom) {
        setRomError(errorMessage(body, `Import failed (HTTP ${response.status}).`));
        return;
      }

      const rom = body.rom;
      setRoms((current) =>
        current.some((entry) => entry.id === rom.id) ? current : [...current, rom],
      );
      setSelectedRomId(rom.id);
      setImportNotice(body.created ? `Imported ${rom.name}.` : 'That ROM is already imported.');
    } catch {
      setRomError('Could not reach the local server.');
    } finally {
      setUploading(false);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file) void uploadRom(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void uploadRom(file);
  };

  const handleChannelSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalized = normalizeTwitchChannel(channel);
    if (!normalized) {
      setChannelError(MAX_CHANNEL_HINT);
      return;
    }

    setChannel(normalized);
    setChannelError(null);
    setStep(2);
  };

  const handleRomContinue = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!selectedRomId) {
      setRomError('Select or import a ROM to continue.');
      return;
    }

    setRomError(null);
    setStep(3);
  };

  const finishSetup = async (): Promise<void> => {
    if (!selectedRomId) return;

    setFinishing(true);
    setFinishError(null);

    try {
      const settingsResponse = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ channel, romId: selectedRomId }),
      });
      const saved = (await settingsResponse.json().catch(() => null)) as
        (SettingsResponse & { error?: string }) | null;

      if (!settingsResponse.ok || !saved || typeof saved.firstRun !== 'boolean') {
        setFinishError(
          errorMessage(saved, `Could not save setup (HTTP ${settingsResponse.status}).`),
        );
        return;
      }

      let status: EmulatorStatus | null = null;
      let startNotice: string | undefined;
      const startResponse = await fetch('/api/emulator/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ romId: selectedRomId }),
      });
      const startBody = (await startResponse
        .json()
        .catch(() => null)) as EmulatorOperationBody | null;

      if (startResponse.ok && startBody?.status) {
        status = startBody.status;
      } else {
        startNotice = errorMessage(
          startBody,
          `Settings saved, but the emulator did not start (HTTP ${startResponse.status}).`,
        );
      }

      // Re-read persisted state so the dashboard renders exactly what the
      // server stored, including the normalized channel and firstRun flag.
      let next = saved;
      const reloadResponse = await fetch('/api/settings', {
        headers: { accept: 'application/json' },
      }).catch(() => null);
      if (reloadResponse?.ok) {
        const reloaded = (await reloadResponse.json().catch(() => null)) as SettingsResponse | null;
        if (reloaded && typeof reloaded.firstRun === 'boolean') next = reloaded;
      }

      onComplete(next, status, startNotice);
    } catch {
      setFinishError('Could not reach the local server.');
    } finally {
      setFinishing(false);
    }
  };

  return (
    <section
      className="setup-card"
      aria-labelledby="setup-title"
      data-testid="setup-step"
      data-step={step}
    >
      <h2 id="setup-title">First-run setup</h2>

      {step === 1 ? (
        <>
          <p className="lede">
            Run Game Boy, GBC, and GBA games locally and let Twitch chat play along. Start by
            telling the app which channel will host the game.
          </p>

          <form className="setup-form" onSubmit={handleChannelSubmit}>
            <label htmlFor="channel">Twitch channel</label>
            <div className="input-row">
              <span className="input-prefix" aria-hidden="true">
                twitch.tv/
              </span>
              <input
                id="channel"
                name="channel"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="your_channel"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              />
            </div>
            <p className="field-hint">
              Use the channel name without the leading #. You can change this later.
            </p>
            <div className="wizard-actions">
              <button type="submit" className="primary-action">
                Continue
              </button>
              {cancelable ? (
                <button type="button" className="secondary-action" onClick={onCancel}>
                  Cancel
                </button>
              ) : null}
            </div>
            {channelError ? (
              <p className="notice" role="alert">
                {channelError}
              </p>
            ) : null}
          </form>

          <aside className="legal-notice" aria-label="Legal notice">
            <strong>Before you start</strong>
            <p>
              You must supply your own legally obtained ROMs. Not affiliated with Nintendo, Game
              Freak, or Twitch.
            </p>
          </aside>
        </>
      ) : null}

      {step === 2 ? (
        <form className="setup-form rom-import" onSubmit={handleRomContinue}>
          <p className="lede">
            Import a Game Boy, Game Boy Color, or Game Boy Advance ROM. Files are validated and
            stored in the local data directory; the client filename is never used as a path.
          </p>

          <label htmlFor="rom-file">ROM file</label>
          <input
            id="rom-file"
            data-testid="rom-file-input"
            type="file"
            accept=".gb,.gbc,.gba"
            disabled={uploading}
            onChange={handleFileChange}
          />

          <div
            className="drop-zone"
            data-testid="rom-drop-zone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <strong>Drag and drop a ROM here</strong>
            <span>.gb, .gbc, or .gba · up to 32 MiB</span>
          </div>

          {uploading ? (
            <p className="field-hint" role="status">
              Importing ROM…
            </p>
          ) : null}
          {importNotice ? (
            <p className="notice" role="status">
              {importNotice}
            </p>
          ) : null}
          {romError ? (
            <p className="notice" role="alert" data-testid="rom-error">
              {romError}
            </p>
          ) : null}

          <h3>Imported ROMs</h3>
          {!romsLoaded ? <p className="field-hint">Loading imported ROMs…</p> : null}
          {romsLoaded && roms.length === 0 ? (
            <p className="field-hint">No ROMs imported yet.</p>
          ) : null}
          {roms.length > 0 ? (
            <ul className="rom-list" data-testid="rom-list">
              {roms.map((rom) => (
                <li key={rom.id}>
                  <label className="rom-option">
                    <input
                      type="radio"
                      name="rom"
                      checked={selectedRomId === rom.id}
                      onChange={() => setSelectedRomId(rom.id)}
                      data-testid={`rom-select-${rom.id}`}
                    />
                    <span className="rom-copy">
                      <strong data-testid="rom-title">{rom.title}</strong>
                      <span className="rom-meta">
                        <span data-testid="rom-model">{rom.model}</span> · {rom.platform} ·{' '}
                        {formatBytes(rom.size)}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          {romsError ? (
            <p className="notice" role="alert">
              {romsError}
            </p>
          ) : null}

          <div className="wizard-actions">
            <button
              type="button"
              className="secondary-action"
              onClick={() => {
                setRomError(null);
                setStep(1);
              }}
            >
              Back
            </button>
            <button type="submit" className="primary-action" disabled={!selectedRomId || uploading}>
              Continue
            </button>
          </div>
        </form>
      ) : null}

      {step === 3 ? (
        <div className="review">
          <p className="lede">
            Check the channel and ROM, then finish setup. This saves the selection and starts the
            emulator.
          </p>
          <dl className="review-list">
            <div>
              <dt>Twitch channel</dt>
              <dd data-testid="review-channel">{channel}</dd>
            </div>
            <div>
              <dt>ROM</dt>
              <dd data-testid="review-rom">
                {selectedRom ? `${selectedRom.title} · ${selectedRom.model}` : 'No ROM selected'}
              </dd>
            </div>
          </dl>
          {finishError ? (
            <p className="notice" role="alert">
              {finishError}
            </p>
          ) : null}
          <div className="wizard-actions">
            <button type="button" className="secondary-action" onClick={() => setStep(2)}>
              Back
            </button>
            <button
              type="button"
              className="primary-action"
              data-testid="setup-finish"
              disabled={finishing || !selectedRomId}
              onClick={() => void finishSetup()}
            >
              {finishing ? 'Finishing…' : 'Finish setup'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
