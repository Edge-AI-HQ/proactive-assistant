import { mkdir } from "node:fs/promises";

import type { CoreContext } from "../context.js";
import { buildDatabasePaths, type PinDatabasePaths } from "./paths.js";
import { SqliteDatabase } from "./sqlite_adapter.js";

export interface PinDatabaseRuntimeState {
  dataRoot: string;
  databases: PinDatabasePaths;
}

export type PinDatabaseName = keyof PinDatabasePaths;

export interface PinDatabaseManagerOptions {
  dataRoot: string;
}

export const resolvePinDataRoot = (ctx: CoreContext): string =>
  ctx.env.PIN_DATA_ROOT || `${ctx.homeDir}/.pin`;

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
