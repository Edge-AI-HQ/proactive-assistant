import type { UserRecord } from '../types.js';

export type TelegramDeliveryUser = Pick<UserRecord, 'telegram_user_id' | 'container_port' | 'container_id'>;
