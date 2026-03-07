import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoogleWorkspaceAuthorizedUserCredential,
  buildGoogleWorkspaceCredentialBootstrapShell,
  encodeGoogleWorkspaceAuthorizedUserCredential,
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE,
  GOOGLE_WORKSPACE_CLI_DEFAULT_CREDENTIALS_FILE,
  PINAI_GOOGLE_CREDENTIALS_B64_ENV,
} from "./google_workspace_credentials.js";

test("buildGoogleWorkspaceAuthorizedUserCredential returns gws authorized_user payload", () => {
  assert.deepEqual(
    buildGoogleWorkspaceAuthorizedUserCredential({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    }),
    {
      type: "authorized_user",
      key_type: "authorized_user",
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-token",
    },
  );
});

test("encodeGoogleWorkspaceAuthorizedUserCredential base64-encodes formatted json", () => {
  const encoded = encodeGoogleWorkspaceAuthorizedUserCredential(
    buildGoogleWorkspaceAuthorizedUserCredential({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    }),
  );
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  assert.match(decoded, /"client_id": "client-id"/);
  assert.match(decoded, /"refresh_token": "refresh-token"/);
});

test("buildGoogleWorkspaceCredentialBootstrapShell writes and removes expected files", () => {
  const shell = buildGoogleWorkspaceCredentialBootstrapShell();
  assert.match(shell, new RegExp(PINAI_GOOGLE_CREDENTIALS_B64_ENV));
  assert.match(shell, new RegExp(GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(shell, new RegExp(GOOGLE_WORKSPACE_CLI_DEFAULT_CREDENTIALS_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(shell, /base64 -d/);
  assert.match(shell, /rm -f/);
});
