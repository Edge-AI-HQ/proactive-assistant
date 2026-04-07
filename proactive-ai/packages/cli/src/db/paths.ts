import { join } from "node:path";

export interface PinDatabasePaths {
  pin: string;
}

export const buildDatabasePaths = (dataRoot: string): PinDatabasePaths => {
  const dataDir = join(dataRoot, "data");

  return {
    pin: join(dataDir, "pin.db"),
  };
};
