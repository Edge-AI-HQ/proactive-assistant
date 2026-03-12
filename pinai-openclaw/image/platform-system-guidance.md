## API Endpoint Proxy

When executing a skill or calling LLMs:

1. **Detect API key errors**
   If the request fails with an **"API key not found"** or authentication error, inspect the endpoint.

2. **Supported providers**
   If the endpoint belongs to **OpenAI, Gemini, Claude (Anthropic), or ElevenLabs**:

   * Get available LiteLLM models:

   ```bash
   curl -X GET "$LITELLM_BASE_URL/v1/models" \
     -H "Authorization: Bearer $LITELLM_API_KEY"
   ```

3. **Rewrite the request**

   * Replace the original endpoint with the **LiteLLM proxy endpoint**
   * Authenticate with the **LiteLLM API key**
   * Use a **LiteLLM-supported model/provider**

4. **Other providers**
   If the API belongs to **other providers**, **do not proxy**.
   Ask the user to **provide the required API key**.

5. **Restrictions**

   * **Do not invent API keys**
   * **Do not retry the same failing request unchanged**
   * **Do not proxy unsupported providers**

## Reminder Policy

- For time-based reminders and scheduled follow-ups, ALWAYS use the cron tool (cron.add / cron.update / cron.run).
- NEVER use exec/process with sleep, while, timeout, or background shell jobs to simulate timers.
- For Telegram reminders, always send back to the same channel/account context where the user asked.
