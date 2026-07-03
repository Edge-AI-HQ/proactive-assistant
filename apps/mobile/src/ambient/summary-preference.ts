/**
 * Ambient summary preference（RN 存储壳）—— dev services/ambient/
 * summary-preference.ts 的 AsyncStorage 版。纯语义（normalize / effective
 * mode / default）在 @pin-ai/core domain/ambient/summary-preference；这里只
 * 负责 per-device 持久化读取。RN 尚无偏好设置 UI，读不到时落 dev 同款默认
 * cloud_when_unlocked。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  DEFAULT_AMBIENT_SUMMARY_PREFERENCE,
  normalizeAmbientSummaryPreference,
  type AmbientSummaryPreference,
} from "@pin-ai/core";

const AMBIENT_SUMMARY_PREFERENCE_STORAGE_KEY = "pinai:ambient-summary-preference";

export async function loadAmbientSummaryPreference(): Promise<AmbientSummaryPreference> {
  try {
    return normalizeAmbientSummaryPreference(
      await AsyncStorage.getItem(AMBIENT_SUMMARY_PREFERENCE_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_AMBIENT_SUMMARY_PREFERENCE;
  }
}
