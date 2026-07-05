-- pai_user_settings 增加 timezone —— lifelong-memory sunset:pai_profile 退役。
--
-- timezone 是 pai_profile 里唯一还有运行时消费者的 identity 字段:
--   * chat worker 把它带进 <current_datetime> 锚点(chat 无 DB 不能猜日期);
--   * generator 的 "Today is …" 用用户本地日期;
--   * auto.dreaming 每日 06:00 排程按用户时区 next_fire;
--   * /api/settings 的设备时区引导(X-Pin-Client-Timezone)+ cron retime。
-- locale / display_name 没有运行时消费者(locale 只是 generation_language 的
-- seed 中介,已被 client locale 头直接 seed 取代;display_name 无 pai_profile
-- 读路径,onboarding 自管),随 pai_profile 一起 DROP,不迁。
--
-- expand-contract 的 expand 阶段:列先加 + 数据先搬;pai_profile 在后续
-- DROP migration(114)删除,届时 timezone 已落在 pai_user_settings。

ALTER TABLE pai_user_settings
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

-- 把已确立的设备时区从 pai_profile 搬过来。只搬非默认值:没建档或仍是建行
-- 默认 'UTC' 的用户,settings 列默认 'UTC' 即可,无需 UPDATE。
UPDATE pai_user_settings s
SET timezone = p.timezone
FROM pai_profile p
WHERE p.user_id = s.user_id
  AND p.timezone IS NOT NULL
  AND p.timezone <> 'UTC';
