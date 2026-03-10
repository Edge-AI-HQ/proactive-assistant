const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

const quoteForShell = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

const dirOf = (filePath: string): string => {
  const idx = filePath.lastIndexOf('/');
  return idx <= 0 ? '/' : filePath.slice(0, idx);
};

const assertSafeBase64 = (encoded: string): void => {
  if (!encoded || !BASE64_RE.test(encoded)) {
    throw new Error('Invalid Google credential payload for hot sync');
  }
};

export const buildGoogleCredentialWriteShell = (
  encoded: string,
  targetFile: string,
  gwsDefaultFile: string,
): string => {
  assertSafeBase64(encoded);
  const targetDir = dirOf(targetFile);
  const gwsDefaultDir = dirOf(gwsDefaultFile);

  return [
    `mkdir -p ${quoteForShell(targetDir)} ${quoteForShell(gwsDefaultDir)}`,
    `printf %s ${quoteForShell(encoded)} | base64 -d > ${quoteForShell(targetFile)}`,
    `cp ${quoteForShell(targetFile)} ${quoteForShell(gwsDefaultFile)}`,
  ].join(' && ');
};

export const buildGoogleCredentialRemoveShell = (
  targetFile: string,
  gwsDefaultFile: string,
): string => {
  return `rm -f ${quoteForShell(targetFile)} ${quoteForShell(gwsDefaultFile)}`;
};
