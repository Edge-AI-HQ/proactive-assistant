import { mkdir } from "node:fs/promises";

import { appPaths } from "../paths.js";
import { SqliteDatabase } from "./sqlite_adapter.js";

export interface PinDatabasePaths {
  pin: string;
}

export interface PinDatabaseRuntimeState {
  dataRoot: string;
  databases: PinDatabasePaths;
}

export type PinDatabaseName = keyof PinDatabasePaths;

function buildDatabasePaths(dataRoot: string): PinDatabasePaths {
  return { pin: appPaths.pinDb(dataRoot) };
}

export class PinDatabaseManager {
  private state: PinDatabaseRuntimeState | null = null;

  constructor(private readonly dataRoot: string) {}

  async init(): Promise<PinDatabaseRuntimeState> {
    await mkdir(appPaths.dataDir(this.dataRoot), { recursive: true });

    this.state = {
      dataRoot: this.dataRoot,
      databases: buildDatabasePaths(this.dataRoot),
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
        dataRoot: this.dataRoot,
        databases: buildDatabasePaths(this.dataRoot),
      };
    }

    return this.state;
  }
}
