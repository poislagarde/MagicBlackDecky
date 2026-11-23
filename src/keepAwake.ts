import { call } from "@decky/api";
import { KeepAwakeController } from "./keepAwakeCore";
import { loadBooleanSetting } from "./settings";

export const KEEP_AWAKE_SETTING = "keep_awake";
const BACKUP_SETTING = "keep_awake_backup";

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

// Retries because the backend may still be starting when the frontend loads.
const callWithRetry = async <T>(fn: () => Promise<T>, attempts = 5): Promise<T> => {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw lastError;
};

export const createKeepAwakeController = () =>
  new KeepAwakeController({
    load: () =>
      callWithRetry(async () => {
        const value = await call<[string], string | null>("load_setting", BACKUP_SETTING);
        return value == null ? "" : String(value);
      }),
    save: async (value: string) => {
      try {
        return (await call<[string, string], boolean | null>("save_setting", BACKUP_SETTING, value)) !== false;
      } catch (error) {
        console.error("[MagicBlack][KeepAwake] Failed to save backup", error);
        return false;
      }
    },
  });

export const loadKeepAwakeEnabled = () => loadBooleanSetting(KEEP_AWAKE_SETTING, false);
