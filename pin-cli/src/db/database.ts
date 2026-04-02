import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";

import { buildDatabasePaths, type PinDatabasePaths } from "./paths.js";
import { SqliteDatabase } from "./sqlite_adapter.js";

export interface ResolvePinDataRootInput {
  env: Record<string, string | undefined>;
  homeDir: string;
}

export interface PinDatabaseRuntimeState {
  dataRoot: string;
  databases: PinDatabasePaths;
}

export type PinDatabaseName = keyof PinDatabasePaths;

export interface PinDatabaseManagerOptions {
  dataRoot: string;
}

export const resolvePinDataRoot = ({
  env,
  homeDir,
}: ResolvePinDataRootInput): string => env.PIN_DATA_ROOT || `${homeDir}/.pin`;

export const resolveDefaultPinDataRoot = (): string =>
  resolvePinDataRoot({
    env: process.env,
    homeDir: homedir(),
  });

export class PinDatabaseManager {
  private state: PinDatabaseRuntimeState | null = null;

  constructor(private readonly options: PinDatabaseManagerOptions) {}

  async init(): Promise<PinDatabaseRuntimeState> {
    const dataRoot = this.options.dataRoot;
    const dataDir = `${dataRoot}/data`;

    await mkdir(dataDir, { recursive: true });

    this.state = {
      dataRoot,
      databases: buildDatabasePaths(dataRoot),
    };

    return this.state;
  }

  open(name: PinDatabaseName): SqliteDatabase {
    const state = this.getState();
    return new SqliteDatabase(state.databases[name]);
  }

  getState(): PinDatabaseRuntimeState {
    if (!this.state) {
      this.state = {
        dataRoot: this.options.dataRoot,
        databases: buildDatabasePaths(this.options.dataRoot),
      };
    }

    return this.state;
  }
}
