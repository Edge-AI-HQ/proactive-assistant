-- Transition to plaintext LiteLLM virtual key storage.
-- Testing-stage migration: clear existing key material to avoid mixed encrypted/plaintext payloads.

UPDATE users
SET
  litellm_key_alias = NULL,
  litellm_virtual_key_encrypted = NULL,
  litellm_key_last4 = NULL
WHERE litellm_virtual_key_encrypted IS NOT NULL
  AND BTRIM(litellm_virtual_key_encrypted) <> '';

UPDATE assistants
SET
  litellm_key_alias = NULL,
  litellm_virtual_key_encrypted = NULL,
  litellm_key_last4 = NULL
WHERE litellm_virtual_key_encrypted IS NOT NULL
  AND BTRIM(litellm_virtual_key_encrypted) <> '';
