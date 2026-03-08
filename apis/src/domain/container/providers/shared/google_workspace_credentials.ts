export const GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE =
  "/app/google/gws-credentials.json";
export const GOOGLE_WORKSPACE_CLI_DEFAULT_CREDENTIALS_FILE =
  "/root/.config/gws/credentials.json";
export const PINAI_GOOGLE_CREDENTIALS_B64_ENV =
  "PINAI_GOOGLE_CREDENTIALS_B64";
export const GOOGLE_CREDENTIALS_RUNTIME_METADATA_KEY =
  "google_credentials_b64";

export type GoogleWorkspaceAuthorizedUserCredential = {
  type: "authorized_user";
  key_type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
};

export const buildGoogleWorkspaceAuthorizedUserCredential = (params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): GoogleWorkspaceAuthorizedUserCredential => ({
  type: "authorized_user",
  key_type: "authorized_user",
  client_id: params.clientId,
  client_secret: params.clientSecret,
  refresh_token: params.refreshToken,
});

export const encodeGoogleWorkspaceAuthorizedUserCredential = (
  credential: GoogleWorkspaceAuthorizedUserCredential,
): string =>
  Buffer.from(`${JSON.stringify(credential, null, 2)}\n`, "utf8").toString(
    "base64",
  );

export const buildGoogleWorkspaceCredentialBootstrapShell = (
  envVarName = PINAI_GOOGLE_CREDENTIALS_B64_ENV,
): string =>
  [
    `mkdir -p ${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE.replace(/\/[^/]+$/, "")} /root/.config/gws`,
    `if [ -n "\${${envVarName}:-}" ]; then printf "%s" "$${envVarName}" | base64 -d > ${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE} && cp ${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE} ${GOOGLE_WORKSPACE_CLI_DEFAULT_CREDENTIALS_FILE}; else rm -f ${GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE} ${GOOGLE_WORKSPACE_CLI_DEFAULT_CREDENTIALS_FILE}; fi`,
  ].join(" && ");
