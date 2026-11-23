// Keep the Deck awake (no idle sleep, no Steam screensaver) while the overlay is on.
// This file has no imports so it can be evaluated on its own in Steam's SharedJSContext for testing.

const LOG = "[MagicBlack][KeepAwake]";

// Protobuf field numbers of CMsgClientSettings (from steamui/sp.js).
export const IDLE_FIELDS = {
  system_idle_suspend_battery_sec: 24003,
  system_idle_suspend_ac_sec: 24004,
  system_idle_screensaver_battery_sec: 24008,
  system_idle_screensaver_ac_sec: 24009,
} as const;

export type IdleKey = keyof typeof IDLE_FIELDS;
export type IdleValues = Record<IdleKey, number>;

const IDLE_KEYS = Object.keys(IDLE_FIELDS) as IdleKey[];

// 0 means "Never" for every idle setting.
const NEVER: IdleValues = {
  system_idle_suspend_battery_sec: 0,
  system_idle_suspend_ac_sec: 0,
  system_idle_screensaver_battery_sec: 0,
  system_idle_screensaver_ac_sec: 0,
};

const isValidSeconds = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0x7fffffff;

const varint = (n: number): number[] => {
  const bytes: number[] = [];
  while (n > 127) {
    bytes.push((n & 127) | 128);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return bytes;
};

// Wire type 0 (varint) field.
const encodeField = (field: number, value: number): number[] => [...varint(field * 8), ...varint(value)];

export const parseIdleValues = (raw: unknown): IdleValues | null => {
  let obj: any = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") {
      return null;
    }
    try {
      obj = JSON.parse(raw);
    } catch {
      console.error(LOG, "Invalid saved backup, ignoring", raw);
      return null;
    }
  }
  if (obj == null || typeof obj !== "object") {
    return null;
  }
  const out = {} as IdleValues;
  for (const key of IDLE_KEYS) {
    if (!isValidSeconds(obj[key])) {
      console.error(LOG, "Saved backup is missing a valid value for", key, obj);
      return null;
    }
    out[key] = obj[key];
  }
  return out;
};

export const readIdleValues = (): IdleValues | null => {
  const clientSettings = (window as any).settingsStore?.m_ClientSettings;
  if (!clientSettings) {
    console.error(LOG, "settingsStore.m_ClientSettings is not available");
    return null;
  }
  return parseIdleValues(clientSettings);
};

export const writeIdleValues = async (values: IdleValues): Promise<boolean> => {
  const bytes: number[] = [];
  for (const key of IDLE_KEYS) {
    bytes.push(...encodeField(IDLE_FIELDS[key], values[key]));
  }
  try {
    const result = await (window as any).SteamClient.Settings.SetSetting(btoa(String.fromCharCode(...bytes)));
    if (result === false) {
      console.error(LOG, "SetSetting returned false", values);
      return false;
    }
    return true;
  } catch (error) {
    console.error(LOG, "SetSetting failed", values, error);
    return false;
  }
};

// Persistent storage for the original values. load() returns "" when nothing is saved and must throw
// (not return "") if it cannot tell, so we never mistake a backend failure for "no saved values".
export interface BackupStore {
  load(): Promise<string>;
  save(value: string): Promise<boolean>;
}

export class KeepAwakeController {
  private enabled = false;
  private enabledSetByUser = false;
  private overlayActive = false;
  private backup: IdleValues | null = null; // in-memory mirror of the persisted record
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly store: BackupStore) {}

  // Run once at plugin load. With the overlay off this restores any values left over
  // from a crash, reboot or plugin reload and clears the record.
  init(loadEnabled: () => Promise<boolean>): Promise<void> {
    return this.enqueue(async () => {
      const loaded = await loadEnabled();
      if (!this.enabledSetByUser) {
        this.enabled = loaded;
      }
      await this.reconcile();
    });
  }

  setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    this.enabledSetByUser = true;
    return this.enqueue(() => this.reconcile());
  }

  setOverlayActive(active: boolean): Promise<void> {
    this.overlayActive = active;
    return this.enqueue(() => this.reconcile());
  }

  // Plugin unload: the overlay goes away, so put the values back without waiting on the queue.
  shutdown(): void {
    this.overlayActive = false;
    const backup = this.backup;
    if (!backup) {
      return;
    }
    void writeIdleValues(backup).then((ok) => {
      if (ok) {
        this.backup = null;
        this.store.save("").catch(() => undefined);
      }
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((error) => console.error(LOG, error));
    return this.queue;
  }

  private async reconcile(): Promise<void> {
    if (this.enabled && this.overlayActive) {
      await this.engage();
    } else {
      await this.release();
    }
  }

  private async engage(): Promise<void> {
    if (!this.backup) {
      const persisted = parseIdleValues(await this.store.load());
      if (persisted) {
        // An override is already in place; keep the original values, never the zeros.
        this.backup = persisted;
      } else {
        const current = readIdleValues();
        if (!current) {
          console.error(LOG, "Could not read current idle settings; not overriding");
          return;
        }
        if (!(await this.store.save(JSON.stringify(current)))) {
          console.error(LOG, "Could not persist current idle settings; not overriding");
          return;
        }
        this.backup = current;
        console.log(LOG, "Saved original idle settings", current);
      }
    }
    if (await writeIdleValues(NEVER)) {
      console.log(LOG, "Sleep and screensaver disabled");
    }
  }

  private async release(): Promise<void> {
    const backup = this.backup ?? parseIdleValues(await this.store.load());
    if (!backup) {
      return;
    }
    if (!(await writeIdleValues(backup))) {
      // Keep the record so the next load or toggle tries again.
      this.backup = backup;
      return;
    }
    this.backup = null;
    if (!(await this.store.save(""))) {
      console.error(LOG, "Restored idle settings but could not clear the saved record");
    }
    console.log(LOG, "Restored idle settings", backup);
  }
}
