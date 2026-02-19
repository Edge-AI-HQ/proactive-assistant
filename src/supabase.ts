import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

if (!config.supabase.url || !config.supabase.serviceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}

export const supabase = createClient(config.supabase.url, config.supabase.serviceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});
