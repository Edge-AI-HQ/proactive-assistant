import {
  PinDatabaseManager,
  resolvePinDataRoot,
  type ResolvePinDataRootInput,
} from "../../db/database.js";
import { okEnvelope } from "../../output/envelope.js";

export interface SysDoctorRuntimeInput extends ResolvePinDataRootInput {}

export const runSysDoctor = async (runtime: SysDoctorRuntimeInput) => {
  const dataRoot = resolvePinDataRoot(runtime);
  const manager = new PinDatabaseManager({ dataRoot });
  const state = await manager.init();

  return okEnvelope("sys", "doctor", {
    status: "ok",
    dataRoot: state.dataRoot,
    paths: state.databases,
  });
};
