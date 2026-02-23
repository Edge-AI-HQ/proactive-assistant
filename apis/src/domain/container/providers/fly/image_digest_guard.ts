import { getContainerManagerRuntime } from '../../runtime.js';
import type { ContainerManagerConfig } from '../../types.js';

const config = new Proxy({} as ContainerManagerConfig, {
  get: (_target, prop) => getContainerManagerRuntime().config[prop as keyof ContainerManagerConfig]
});

const FLY_MANIFEST_ACCEPT_HEADER = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');

interface RegistryAuthChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

interface ParsedImageDigestRef {
  registry: string;
  repository: string;
  digest: string;
}

let ensureImagePullablePromise: Promise<void> | null = null;

const parseRegistryAuthChallenge = (rawHeader: string | null): RegistryAuthChallenge | null => {
  if (!rawHeader) return null;

  const trimmed = rawHeader.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;

  const params = trimmed.slice('bearer '.length);
  const entries = Array.from(params.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]*)"/g));
  if (!entries.length) return null;

  const parsed: Partial<RegistryAuthChallenge> = {};
  entries.forEach((match) => {
    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) return;

    const lowerKey = key.toLowerCase();
    if (lowerKey === 'realm') parsed.realm = value;
    if (lowerKey === 'service') parsed.service = value;
    if (lowerKey === 'scope') parsed.scope = value;
  });

  if (!parsed.realm) return null;
  return parsed as RegistryAuthChallenge;
};

const parseImageDigestRef = (rawImage: string): ParsedImageDigestRef | null => {
  const image = rawImage.trim();
  const atIndex = image.lastIndexOf('@');
  if (atIndex <= 0) return null;

  const digest = image.slice(atIndex + 1).toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return null;

  const imageWithoutDigest = image.slice(0, atIndex).trim();
  if (!imageWithoutDigest) return null;

  const firstSlash = imageWithoutDigest.indexOf('/');
  const firstSegment = firstSlash >= 0 ? imageWithoutDigest.slice(0, firstSlash) : imageWithoutDigest;
  const hasExplicitRegistry = firstSegment.includes('.') || firstSegment.includes(':') || firstSegment === 'localhost';

  const registry = hasExplicitRegistry ? firstSegment.toLowerCase() : 'registry-1.docker.io';
  let repository = hasExplicitRegistry ? imageWithoutDigest.slice(firstSlash + 1) : imageWithoutDigest;
  if (!repository) return null;

  const lastSlash = repository.lastIndexOf('/');
  const lastColon = repository.lastIndexOf(':');
  if (lastColon > lastSlash) {
    repository = repository.slice(0, lastColon);
  }

  if (!repository) return null;
  if (registry === 'registry-1.docker.io' && !repository.includes('/')) {
    repository = `library/${repository}`;
  }

  return { registry, repository, digest };
};

const encodeRepositoryPath = (repository: string): string => {
  return repository
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
};

const registryAuthHeaderCandidates = (registry: string): Array<string | null> => {
  const flyToken = config.fly.apiToken.trim();
  if (!flyToken) return [null];

  if (registry === 'registry.fly.io' || registry.endsWith('.fly.io')) {
    const basicValue = Buffer.from(`x:${flyToken}`).toString('base64');
    return [`Bearer ${flyToken}`, `Basic ${basicValue}`, null];
  }

  return [null];
};

const requestRegistryAccessToken = async (
  challenge: RegistryAuthChallenge,
  registry: string
): Promise<string | null> => {
  const tokenUrl = new URL(challenge.realm);
  if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
  if (challenge.scope) tokenUrl.searchParams.set('scope', challenge.scope);

  const authHeaders = registryAuthHeaderCandidates(registry);
  for (const authHeader of authHeaders) {
    const response = await fetch(tokenUrl, {
      headers: {
        ...(authHeader ? { Authorization: authHeader } : {})
      }
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        continue;
      }
      continue;
    }

    const payload = (await response.json()) as { token?: string; access_token?: string };
    const token = (payload.token || payload.access_token || '').trim();
    if (token) return token;
  }

  return null;
};

const assertImageDigestPullable = async (imageRef: ParsedImageDigestRef): Promise<void> => {
  const manifestUrl = `https://${imageRef.registry}/v2/${encodeRepositoryPath(imageRef.repository)}/manifests/${imageRef.digest}`;

  const requestManifest = async (authHeader: string | null): Promise<Response> => {
    const headers: Record<string, string> = {
      Accept: FLY_MANIFEST_ACCEPT_HEADER
    };

    if (authHeader) headers.Authorization = authHeader;

    const head = await fetch(manifestUrl, { method: 'HEAD', headers });
    if (head.status !== 405) {
      return head;
    }

    return fetch(manifestUrl, { method: 'GET', headers });
  };

  const authHeaders = registryAuthHeaderCandidates(imageRef.registry);
  let lastStatus: number | null = null;
  let challenge: RegistryAuthChallenge | null = null;

  for (const authHeader of authHeaders) {
    const response = await requestManifest(authHeader);
    lastStatus = response.status;

    if (response.ok) return;
    if (response.status === 404) {
      throw new Error(`OPENCLAW_IMAGE digest not found in registry: ${config.openclaw.image}`);
    }
    if (response.status === 401) {
      challenge = parseRegistryAuthChallenge(response.headers.get('www-authenticate'));
    }
  }

  if (challenge) {
    const registryToken = await requestRegistryAccessToken(challenge, imageRef.registry);
    if (registryToken) {
      const retryResponse = await requestManifest(`Bearer ${registryToken}`);
      if (retryResponse.ok) return;

      if (retryResponse.status === 404) {
        throw new Error(`OPENCLAW_IMAGE digest not found in registry: ${config.openclaw.image}`);
      }
      lastStatus = retryResponse.status;
    }
  }

  throw new Error(
    `Failed to validate OPENCLAW_IMAGE digest pullability (${config.openclaw.image}). Registry returned status ${
      lastStatus ?? 'unknown'
    }.`
  );
};

const validateFlyImageDigest = async (): Promise<void> => {
  if (config.container.runtime !== 'fly') return;

  const imageRef = parseImageDigestRef(config.openclaw.image);
  if (!imageRef) {
    throw new Error(
      'When CONTAINER_RUNTIME=fly, OPENCLAW_IMAGE must be digest-pinned (example: registry.fly.io/<app>@sha256:<64-hex>).'
    );
  }

  await assertImageDigestPullable(imageRef);
};

export const ensureFlyOpenclawImageDigestPullable = async (): Promise<void> => {
  if (config.container.runtime !== 'fly') return;
  if (ensureImagePullablePromise) return ensureImagePullablePromise;

  const pending = validateFlyImageDigest().catch((error: unknown) => {
    if (ensureImagePullablePromise === pending) {
      ensureImagePullablePromise = null;
    }
    throw error;
  });

  ensureImagePullablePromise = pending;
  return pending;
};
