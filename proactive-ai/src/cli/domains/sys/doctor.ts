import { existsSync } from "node:fs";

import { PinDatabaseManager } from "../../db/database.js";
import { resolveAppRootFromCtx } from "../../../core/paths.js";
import type { CoreContext } from "../../../core/context.js";
import { okEnvelope } from "../../output/envelope.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  message: string;
  hint?: string;
}

export interface SysDoctorRuntimeInput extends CoreContext {}

const CLI_VERSION = "0.2.0";

export const runSysDoctor = async (runtime: SysDoctorRuntimeInput) => {
  const dataRoot = resolveAppRootFromCtx(runtime);
  const manager = new PinDatabaseManager(dataRoot);
  const state = await manager.init();

  const checks: DoctorCheck[] = [];

  checks.push({
    name: "cli_version",
    status: "pass",
    message: CLI_VERSION,
  });

  const dataRootExists = existsSync(dataRoot);
  checks.push({
    name: "data_root",
    status: dataRootExists ? "pass" : "fail",
    message: dataRootExists ? dataRoot : `${dataRoot} does not exist`,
    ...(!dataRootExists ? { hint: "run any `pin` command to auto-create data directory" } : {}),
  });

  for (const [name, dbPath] of Object.entries(state.databases)) {
    const dbExists = existsSync(dbPath);
    checks.push({
      name: `database_${name}`,
      status: dbExists ? "pass" : "warn",
      message: dbExists ? `${name}.db opened` : `${name}.db not yet created`,
      ...(!dbExists ? { hint: "database will be created on first use" } : {}),
    });
  }

  const allOk = checks.every((c) => c.status === "pass" || c.status === "warn");

  return okEnvelope("sys", "doctor", {
    checks,
    ok: allOk,
    dataRoot: state.dataRoot,
    paths: state.databases,
  });
};
