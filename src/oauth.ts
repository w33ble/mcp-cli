import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type OAuthClientProvider,
  auth,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { type HttpServerConfig, getCredentialIdentity } from './config.js';
import { ErrorCode, formatCliError } from './errors.js';

interface CredentialBundle {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

const service = 'mcp-cli.oauth';

type SecretsApi = {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<void>;
};

function secrets(): SecretsApi | undefined {
  return (Bun as unknown as { secrets?: SecretsApi }).secrets;
}

function credentialPath(identity: string): string {
  return join(homedir(), '.config', 'mcp', 'oauth', `${identity}.json`);
}

async function readBundle(
  identity: string,
): Promise<CredentialBundle | undefined> {
  const secureStore = secrets();
  if (secureStore) {
    try {
      const raw = await secureStore.get({ service, name: identity });
      if (raw) return JSON.parse(raw) as CredentialBundle;
    } catch {
      // Headless systems commonly do not have a usable OS credential store.
    }
  }
  try {
    const raw = await readFile(credentialPath(identity), 'utf8');
    const bundle = JSON.parse(raw) as CredentialBundle;
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw new Error('invalid credential bundle');
    }
    return bundle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(
      'OAuth credential storage is corrupt; run auth login again',
    );
  }
}

async function writeBundle(
  identity: string,
  bundle: CredentialBundle,
): Promise<void> {
  const raw = JSON.stringify(bundle);
  const path = credentialPath(identity);
  const secureStore = secrets();
  if (secureStore) {
    try {
      await secureStore.set({ service, name: identity, value: raw });
      await rm(path, { force: true });
      return;
    } catch {
      // Headless systems commonly do not have a usable OS credential store.
    }
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, raw, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

async function clearBundle(identity: string): Promise<void> {
  const secureStore = secrets();
  let secureDeleteFailed = false;
  if (secureStore) {
    try {
      await secureStore.delete({ service, name: identity });
    } catch {
      secureDeleteFailed = true;
    }
  }
  await rm(credentialPath(identity), { force: true });
  if (secureDeleteFailed) {
    throw new Error('Failed to remove OAuth credentials from secure storage');
  }
}

export function authError(serverName: string): Error {
  const error = new Error(
    formatCliError({
      code: ErrorCode.AUTH_ERROR,
      type: 'AUTH_ERROR',
      message: `Authentication is required for server "${serverName}"`,
      suggestion: `Run 'mcp-cli auth login ${serverName}' to authenticate`,
    }),
  );
  (error as Error & { code: ErrorCode }).code = ErrorCode.AUTH_ERROR;
  return error;
}

function isAuthRequiredError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const status = error as Error & { status?: unknown; statusCode?: unknown };
  return (
    error.name === 'UnauthorizedError' ||
    status.status === 401 ||
    status.statusCode === 401 ||
    /\b(401|unauthorized|authentication required|auth required|invalid_token)\b/i.test(
      error.message,
    )
  );
}

export function normalizeMissingOAuthCredentialsError(
  error: unknown,
  serverName: string,
  hasOAuthClient: boolean,
  hasAuthorizationHeader = false,
): Error {
  if (!hasOAuthClient && !hasAuthorizationHeader && isAuthRequiredError(error))
    return authError(serverName);
  return error instanceof Error ? error : new Error('Connection failed');
}

export function sanitizeOAuthLoginError(error: unknown): Error {
  if (error instanceof Error && error.message === 'OAuth callback timed out') {
    return new Error('OAuth login timed out. Try again.');
  }
  if (
    error instanceof Error &&
    error.message === 'OAuth authorization was denied'
  ) {
    return new Error('OAuth authorization was denied. Try again.');
  }
  return new Error(
    'OAuth login failed. Verify the server OAuth configuration and try again.',
  );
}

class StoredOAuthProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;
  state?: () => string;
  private bundle?: CredentialBundle;

  constructor(
    private readonly identity: string,
    private readonly serverName: string,
    readonly redirectUrl: string,
    private readonly interactive: boolean,
  ) {
    this.clientMetadata = {
      client_name: 'mcp-cli',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  private async load(): Promise<CredentialBundle> {
    if (!this.bundle) this.bundle = (await readBundle(this.identity)) ?? {};
    return this.bundle;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.load()).clientInformation;
  }
  async saveClientInformation(
    value: OAuthClientInformationMixed,
  ): Promise<void> {
    if (!this.interactive) throw authError(this.serverName);
    const bundle = await this.load();
    bundle.clientInformation = value;
    await writeBundle(this.identity, bundle);
  }
  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens;
  }
  async saveTokens(value: OAuthTokens): Promise<void> {
    const bundle = await this.load();
    bundle.tokens = value;
    bundle.codeVerifier = undefined;
    await writeBundle(this.identity, bundle);
  }
  async saveCodeVerifier(value: string): Promise<void> {
    if (!this.interactive) throw authError(this.serverName);
    const bundle = await this.load();
    bundle.codeVerifier = value;
    await writeBundle(this.identity, bundle);
  }
  async codeVerifier(): Promise<string> {
    const value = (await this.load()).codeVerifier;
    if (!value) throw authError(this.serverName);
    return value;
  }
  redirectToAuthorization(url: URL): void {
    if (!this.interactive) throw authError(this.serverName);
    process.stderr.write(`Open this URL to authenticate:\n${url.toString()}\n`);
  }
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier',
  ): Promise<void> {
    const bundle = await this.load();
    if (scope === 'all' || scope === 'client') {
      bundle.clientInformation = undefined;
    }
    if (scope === 'all' || scope === 'tokens') bundle.tokens = undefined;
    if (scope === 'all' || scope === 'verifier')
      bundle.codeVerifier = undefined;
    await writeBundle(this.identity, bundle);
  }
}

export function getOAuthIdentity(
  configPath: string | undefined,
  serverName: string,
  config: HttpServerConfig,
): string {
  return getCredentialIdentity(
    configPath ?? process.cwd(),
    serverName,
    config.url,
  );
}

export async function createNonInteractiveOAuthProvider(
  serverName: string,
  config: HttpServerConfig,
  configPath?: string,
): Promise<OAuthClientProvider | undefined> {
  const identity = getOAuthIdentity(configPath, serverName, config);
  const clientInformation = (await readBundle(identity))?.clientInformation;
  const redirectUrl = (
    clientInformation as OAuthClientInformationMixed & {
      redirect_uris?: string[];
    }
  )?.redirect_uris?.[0];
  if (!redirectUrl) return undefined;

  // Refresh requests must use the redirect URI from dynamic registration.
  return new StoredOAuthProvider(identity, serverName, redirectUrl, false);
}

function hasAuthorizationHeader(config: HttpServerConfig): boolean {
  return Object.keys(config.headers ?? {}).some(
    (name) => name.toLowerCase() === 'authorization',
  );
}

function createCallback(expectedState: string): {
  redirectUrl: string;
  wait: () => Promise<string>;
  close: () => void;
} {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const headers = { 'Cache-Control': 'no-store' };
      if (request.method !== 'GET' || url.pathname !== '/oauth/callback') {
        return new Response('Not found', { status: 404, headers });
      }
      if (url.searchParams.get('state') !== expectedState) {
        return new Response('Invalid OAuth callback', { status: 400, headers });
      }
      if (url.searchParams.has('error')) {
        clearTimeout(timer);
        server.stop(true);
        rejectCode(new Error('OAuth authorization was denied'));
        return new Response('Authorization failed', { status: 400, headers });
      }
      const code = url.searchParams.get('code');
      if (!code)
        return new Response('Authorization failed', { status: 400, headers });
      clearTimeout(timer);
      server.stop(true);
      resolveCode(code);
      return new Response(
        'Authentication complete. You can close this window.',
        { headers },
      );
    },
  });
  const timer = setTimeout(
    () => {
      server.stop(true);
      rejectCode(new Error('OAuth callback timed out'));
    },
    5 * 60 * 1000,
  );
  return {
    redirectUrl: `http://127.0.0.1:${server.port}/oauth/callback`,
    wait: () => result,
    close: () => {
      clearTimeout(timer);
      server.stop(true);
    },
  };
}

export async function login(
  serverName: string,
  config: HttpServerConfig,
  configPath?: string,
): Promise<void> {
  if (hasAuthorizationHeader(config)) {
    throw new Error(
      'OAuth login cannot be used with a configured Authorization header',
    );
  }
  let callback: ReturnType<typeof createCallback> | undefined;
  try {
    const identity = getOAuthIdentity(configPath, serverName, config);
    await clearBundle(identity);
    const state = crypto.randomUUID();
    callback = createCallback(state);
    const provider = new StoredOAuthProvider(
      identity,
      serverName,
      callback.redirectUrl,
      true,
    );
    provider.state = () => state;
    await auth(provider, { serverUrl: config.url });
    const code = await callback.wait();
    await auth(provider, { serverUrl: config.url, authorizationCode: code });
  } catch (error) {
    throw sanitizeOAuthLoginError(error);
  } finally {
    callback?.close();
  }
}

export async function logout(
  serverName: string,
  config: HttpServerConfig,
  configPath?: string,
): Promise<boolean> {
  const identity = getOAuthIdentity(configPath, serverName, config);
  const existing = await readBundle(identity);
  await clearBundle(identity);
  return existing !== undefined;
}

export async function oauthStatus(
  serverName: string,
  config: HttpServerConfig,
  configPath?: string,
): Promise<boolean> {
  const bundle = await readBundle(
    getOAuthIdentity(configPath, serverName, config),
  );
  return Boolean(bundle?.tokens);
}
