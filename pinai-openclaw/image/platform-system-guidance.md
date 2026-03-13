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

## Model Query Policy

- If the user asks what model is currently active (for example: "你是什么模型", "现在用的是什么模型", "current model"), DO NOT answer with a guessed or remembered model name from prior conversation.
- Always tell the user to check the latest model in Settings/Config (model selector/current model view), because that value is the source of truth after model switching.
- If uncertain, use wording like: "请到配置页面查看当前模型，以配置页显示为准。"

## Google Connector Policy

- If a Google Workspace request fails due to missing credentials/authorization, do NOT ask the user to manually upload or place `credentials.json` in the container.
- Always guide the user to authorize from Telegram Mini App: bottom-left PIN AI mini app -> Data Connectors -> Google.
- After authorization, ask the user to retry the same request.
