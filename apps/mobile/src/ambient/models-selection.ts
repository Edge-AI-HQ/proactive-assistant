/**
 * 端侧模型选中态持久化（RN）——web services/ambient/models-selection 的对应物。
 * web 用同步 localStorage；RN 用异步 AsyncStorage（函数返回 Promise，调用方 await）。
 * 存储键与 web 一致（pinai:ambient-models-*）。mirror 偏好也并入这里。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { ModelMirror } from "../../modules/ambient-models";

const SUMMARY_KEY = "pinai:ambient-models-selected-id";
const ASR_KEY = "pinai:ambient-models-selected-asr-id";
const MIRROR_KEY = "pinai:ambient-models-preferred-mirror";

async function read(key: string): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(key);
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function write(key: string, id: string): Promise<void> {
  const normalized = id.trim();
  if (!normalized) return;
  try {
    await AsyncStorage.setItem(key, normalized);
  } catch {
    // ignore storage failures（debug surface only）
  }
}

async function clear(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // ignore storage failures
  }
}

export const getSelectedAmbientSummaryModelId = () => read(SUMMARY_KEY);
export const setSelectedAmbientSummaryModelId = (id: string) => write(SUMMARY_KEY, id);
export const clearSelectedAmbientSummaryModelId = () => clear(SUMMARY_KEY);

export const getSelectedAmbientAsrModelId = () => read(ASR_KEY);
export const setSelectedAmbientAsrModelId = (id: string) => write(ASR_KEY, id);
export const clearSelectedAmbientAsrModelId = () => clear(ASR_KEY);

export async function getPreferredMirror(): Promise<ModelMirror> {
  const value = await read(MIRROR_KEY);
  return value === "hf" || value === "hf-mirror" ? value : "hf-mirror";
}

export async function setPreferredMirror(value: ModelMirror): Promise<void> {
  await write(MIRROR_KEY, value);
}
