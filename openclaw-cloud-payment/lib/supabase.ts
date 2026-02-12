import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY!;

// 使用 Service Role Key 以绕过 RLS
export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// 数据库操作接口
export interface UserSubscription {
  id: number;
  telegram_user_id: string;
  telegram_username?: string;
  stripe_customer_id: string;
  stripe_subscription_id?: string;
  docker_container_id?: string;
  docker_port?: number;
  docker_url?: string;
  status: 'active' | 'paused' | 'canceled' | 'pending';
  current_period_start?: string;
  current_period_end?: string;
  created_at: string;
  updated_at: string;
}

export const db = {
  // 创建或更新用户订阅
  async upsertUserSubscription(data: {
    telegram_user_id: string;
    telegram_username?: string;
    stripe_customer_id: string;
    stripe_subscription_id?: string;
  }) {
    const { data: result, error } = await supabase
      .from('user_subscriptions')
      .upsert(
        {
          telegram_user_id: data.telegram_user_id,
          telegram_username: data.telegram_username,
          stripe_customer_id: data.stripe_customer_id,
          stripe_subscription_id: data.stripe_subscription_id,
        },
        {
          onConflict: 'telegram_user_id',
        }
      )
      .select()
      .single();

    if (error) throw error;
    return result;
  },

  // 根据 Telegram 用户 ID 获取订阅
  async getSubscriptionByTelegramId(
    telegram_user_id: string
  ): Promise<UserSubscription | null> {
    const { data, error } = await supabase
      .from('user_subscriptions')
      .select('*')
      .eq('telegram_user_id', telegram_user_id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  // 根据 Stripe 客户 ID 获取订阅
  async getSubscriptionByStripeCustomerId(
    stripe_customer_id: string
  ): Promise<UserSubscription | null> {
    const { data, error } = await supabase
      .from('user_subscriptions')
      .select('*')
      .eq('stripe_customer_id', stripe_customer_id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  // 根据 Stripe 订阅 ID 获取订阅
  async getSubscriptionByStripeSubscriptionId(
    stripe_subscription_id: string
  ): Promise<UserSubscription | null> {
    const { data, error } = await supabase
      .from('user_subscriptions')
      .select('*')
      .eq('stripe_subscription_id', stripe_subscription_id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  // 更新订阅状态
  async updateSubscriptionStatus(
    telegram_user_id: string,
    status: 'active' | 'paused' | 'canceled' | 'pending',
    period_start?: Date,
    period_end?: Date
  ) {
    const { error } = await supabase
      .from('user_subscriptions')
      .update({
        status,
        current_period_start: period_start?.toISOString(),
        current_period_end: period_end?.toISOString(),
      })
      .eq('telegram_user_id', telegram_user_id);

    if (error) throw error;
  },

  // 更新 Docker 容器信息
  async updateDockerInfo(
    telegram_user_id: string,
    container_id: string,
    port: number,
    url: string
  ) {
    const { error } = await supabase
      .from('user_subscriptions')
      .update({
        docker_container_id: container_id,
        docker_port: port,
        docker_url: url,
      })
      .eq('telegram_user_id', telegram_user_id);

    if (error) throw error;
  },

  // 记录支付事件
  async logPaymentEvent(data: {
    telegram_user_id?: string;
    stripe_event_id: string;
    event_type: string;
    amount?: number;
    currency?: string;
    status?: string;
    raw_data?: any;
  }) {
    const { error } = await supabase.from('payment_events').insert({
      telegram_user_id: data.telegram_user_id,
      stripe_event_id: data.stripe_event_id,
      event_type: data.event_type,
      amount: data.amount,
      currency: data.currency,
      status: data.status,
      raw_data: data.raw_data,
    });

    if (error && error.code !== '23505') throw error; // 忽略重复事件
  },

  // 记录容器日志
  async logContainerAction(
    telegram_user_id: string,
    container_id: string,
    action: 'created' | 'started' | 'stopped' | 'removed' | 'error',
    message?: string
  ) {
    const { error } = await supabase.from('container_logs').insert({
      telegram_user_id,
      container_id,
      action,
      message,
    });

    if (error) throw error;
  },

  // 获取所有活跃订阅
  async getActiveSubscriptions(): Promise<UserSubscription[]> {
    const { data, error } = await supabase
      .from('user_subscriptions')
      .select('*')
      .eq('status', 'active');

    if (error) throw error;
    return data || [];
  },
};
