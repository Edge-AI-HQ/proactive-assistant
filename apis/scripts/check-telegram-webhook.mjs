#!/usr/bin/env node

// This script checks the current Telegram webhook status
// Usage: TELEGRAM_BOT_TOKEN=xxx node check-telegram-webhook.mjs

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN environment variable is required');
  process.exit(1);
}

async function checkWebhook() {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = await response.json();
    
    if (!data.ok) {
      console.error('Error from Telegram API:', data);
      process.exit(1);
    }
    
    console.log('Current webhook info:');
    console.log(JSON.stringify(data.result, null, 2));
    
    if (!data.result.url) {
      console.log('\n⚠️  WARNING: No webhook URL is set!');
    } else if (data.result.last_error_date) {
      console.log('\n⚠️  WARNING: There were errors delivering webhook updates:');
      console.log('Last error date:', new Date(data.result.last_error_date * 1000).toISOString());
      console.log('Last error message:', data.result.last_error_message);
    } else {
      console.log('\n✅ Webhook is configured and working');
    }
  } catch (error) {
    console.error('Error checking webhook:', error.message);
    process.exit(1);
  }
}

checkWebhook();
