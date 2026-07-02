/**
 * Scheduled Tasks 设置 —— web `ui-web/account/ScheduledTasksSettings.tsx` 的 RN
 * 对应物（Preferences 子页第三 section）。列表 + 暂停/恢复开关 + 删除；
 * 数据走 @pin-ai/core scheduled-generators 域函数（零重写）。
 * 文案走 i18n（account:scheduledTasks.*，与 dev 同 key）。
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  deleteScheduledGenerator,
  listScheduledGenerators,
  pauseScheduledGenerator,
  resumeScheduledGenerator,
  type ScheduledGeneratorTask,
} from "@pin-ai/core";

import i18n from "../../i18n";
import { SettingsSwitch } from "./SettingsSwitch";

const FG = "230, 25%, 15%";
const fg = (a?: number) => (a === undefined ? `hsl(${FG})` : `hsla(${FG}, ${a})`);
// Tailwind emerald-600 / emerald-500/10、amber-700 / amber-500/10、red-500。
const EMERALD_600 = "#059669";
const EMERALD_BG = "rgba(16,185,129,0.1)";
const AMBER_700 = "#b45309";
const AMBER_BG = "rgba(245,158,11,0.1)";
const RED_500 = "#ef4444";

// Server-rendered label ("每 5 分钟" / "一次 · 06-10 15:00") wins; legacy tasks
// without scheduleLabel fall back to joining the cron fields, dropping empty
// parts so a missing field doesn't render stray separators.
function formatSchedule(task: ScheduledGeneratorTask): string {
  if (task.scheduleLabel) return task.scheduleLabel;
  return [task.frequency, task.localTime, task.timezone].filter(Boolean).join(" · ");
}

export default function ScheduledTasksSettings() {
  const { t } = useTranslation("account");
  const [tasks, setTasks] = useState<ScheduledGeneratorTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const items = await listScheduledGenerators();
        if (mounted) setTasks(items);
      } catch {
        if (mounted) setError(i18n.t("account:scheduledTasks.loadFailed"));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const handleToggle = async (task: ScheduledGeneratorTask) => {
    const next = task.status === "active" ? "paused" : "active";
    setPendingId(task.id);
    setError(null);
    try {
      const updated =
        next === "paused"
          ? await pauseScheduledGenerator(task.id)
          : await resumeScheduledGenerator(task.id);
      setTasks((current) => current.map((t) => (t.id === task.id ? updated : t)));
    } catch {
      setError(next === "paused" ? t("scheduledTasks.pauseFailed") : t("scheduledTasks.resumeFailed"));
    } finally {
      setPendingId(null);
    }
  };

  const handleDelete = async (task: ScheduledGeneratorTask) => {
    setPendingId(task.id);
    setError(null);
    try {
      await deleteScheduledGenerator(task.id);
      setTasks((current) => current.filter((t) => t.id !== task.id));
    } catch {
      setError(t("scheduledTasks.deleteFailed"));
    } finally {
      setPendingId(null);
    }
  };

  if (loading) {
    return (
      <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
        {t("scheduledTasks.loading")}
      </Text>
    );
  }

  if (tasks.length === 0) {
    return (
      <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}>
        {t("scheduledTasks.empty")}
      </Text>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      {tasks.map((task) => {
        const active = task.status === "active";
        const busy = pendingId === task.id;
        const title = task.title || t("scheduledTasks.fallbackTitle");
        return (
          <View
            key={task.id}
            style={{ borderRadius: 16, backgroundColor: fg(0.04), paddingHorizontal: 12, paddingVertical: 12, gap: 8 }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  numberOfLines={1}
                  style={{ fontFamily: "Inter_500Medium", fontSize: 12, lineHeight: 16, color: fg() }}
                >
                  {title}
                </Text>
                <Text
                  style={{ marginTop: 2, fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: fg(0.45) }}
                >
                  {formatSchedule(task)}
                </Text>
              </View>
              <SettingsSwitch
                size="md"
                on={active}
                disabled={busy}
                onPress={() => void handleToggle(task)}
                accessibilityLabel={t("scheduledTasks.activeAria", { title })}
              />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <View
                style={{
                  borderRadius: 999,
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                  backgroundColor: active ? EMERALD_BG : AMBER_BG,
                }}
              >
                <Text
                  style={{
                    fontFamily: "Inter_500Medium",
                    fontSize: 10,
                    lineHeight: 14,
                    color: active ? EMERALD_600 : AMBER_700,
                  }}
                >
                  {active ? t("scheduledTasks.statusActive") : t("scheduledTasks.statusPaused")}
                </Text>
              </View>
              <Pressable onPress={() => void handleDelete(task)} disabled={busy} hitSlop={8}>
                <Text
                  style={{
                    fontFamily: "Inter_400Regular",
                    fontSize: 11,
                    lineHeight: 15,
                    color: "rgba(239,68,68,0.8)",
                    opacity: busy ? 0.4 : 1,
                  }}
                >
                  {t("scheduledTasks.delete")}
                </Text>
              </Pressable>
            </View>
          </View>
        );
      })}
      {error ? (
        <Text style={{ fontFamily: "Inter_400Regular", fontSize: 11, lineHeight: 15, color: `${RED_500}cc` }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
