import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createConfiguredFetch } from '../src/client';
import { ErrorCode } from '../src/errors';
import {
  createNonInteractiveOAuthProvider,
  getOAuthIdentity,
  login,
  logout,
  normalizeMissingOAuthCredentialsError,
  oauthStatus,
  sanitizeOAuthLoginError,
} from '../src/oauth';

const config = { url: 'https://mcp.example.test/mcp' };
const identity = getOAuthIdentity('/tmp/oauth-test', 'test', config);
const credentialFile = join(homedir(), '.config', 'mcp', 'oauth', `${identity}.json`);

afterEach(async () => {
  await rm(credentialFile, { force: true });
});

describe('OAuth login', () => {
  test('completes against an authorization server that requires the iss callback parameter', async () => {
    // RFC 9207: an AS advertising iss support makes the SDK reject callbacks without `iss`
    const as = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const base = url.origin;

        if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
          return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
        }
        if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
          return Response.json({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            authorization_response_iss_parameter_supported: true,
          });
        }
        if (url.pathname === '/register') {
          // Fake AS: echo the SDK's own registration body back as the client record
          const metadata = (await request.json()) as Record<string, unknown>;
          return Response.json({ ...metadata, client_id: 'test-client' }, { status: 201 });
        }
        if (url.pathname === '/authorize') {
          const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
          callback.searchParams.set('code', 'test-code');
          callback.searchParams.set('state', url.searchParams.get('state') ?? '');
          callback.searchParams.set('iss', base);
          return Response.redirect(callback.toString(), 302);
        }
        if (url.pathname === '/token') {
          return Response.json({ access_token: 'access', token_type: 'Bearer', expires_in: 3600 });
        }
        return new Response('Not found', { status: 404 });
      },
    });
    const server = { url: `http://127.0.0.1:${as.port}/mcp` };
    const configPath = '/tmp/oauth-login-test';

    // login() prints the authorization URL for the user; play the browser by following it
    const authorizeUrl = Promise.withResolvers<string>();
    const stderr = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      const match = String(chunk).match(/^http\S+/m);
      if (match) authorizeUrl.resolve(match[0]);
      return true;
    });

    try {
      const loggedIn = login('iss-test', server, configPath);
      await fetch(await authorizeUrl.promise);
      await loggedIn;

      expect(await oauthStatus('iss-test', server, configPath)).toBe(true);
    } finally {
      stderr.mockRestore();
      await logout('iss-test', server, configPath);
      as.stop(true);
    }
  });
});

describe('OAuth', () => {
  test('uses the redirect URI stored by dynamic registration', async () => {
    await mkdir(join(homedir(), '.config', 'mcp', 'oauth'), {
      recursive: true,
    });
    await writeFile(
      credentialFile,
      JSON.stringify({
        clientInformation: {
          client_id: 'client-id',
          redirect_uris: ['http://127.0.0.1:43821/oauth/callback'],
        },
      })
    );

    const provider = await createNonInteractiveOAuthProvider('test', config, '/tmp/oauth-test');

    if (!provider) throw new Error('expected an OAuth provider');
    expect(provider.clientMetadata.redirect_uris).toEqual([
      'http://127.0.0.1:43821/oauth/callback',
    ]);
  });

  test('invalidates only OAuth tokens when requested', async () => {
    await mkdir(join(homedir(), '.config', 'mcp', 'oauth'), {
      recursive: true,
    });
    await writeFile(
      credentialFile,
      JSON.stringify({
        clientInformation: {
          client_id: 'client-id',
          redirect_uris: ['http://127.0.0.1:43821/oauth/callback'],
        },
        tokens: { access_token: 'access', token_type: 'bearer' },
        codeVerifier: 'verifier',
      })
    );

    const provider = await createNonInteractiveOAuthProvider('test', config, '/tmp/oauth-test');
    if (!provider?.invalidateCredentials) {
      throw new Error('expected an OAuth provider with invalidation support');
    }

    await provider.invalidateCredentials('tokens');

    expect(await provider.clientInformation()).toMatchObject({
      client_id: 'client-id',
    });
    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.codeVerifier()).toBe('verifier');
  });

  test('turns an unauthorized response without stored OAuth credentials into an auth error', () => {
    const error = normalizeMissingOAuthCredentialsError(
      Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedError' }),
      'test',
      false
    );

    expect((error as Error & { code?: ErrorCode }).code).toBe(ErrorCode.AUTH_ERROR);
    expect(error.message).toContain('mcp-cli auth login test');
  });

  test('turns OAuth invalid_token responses into an auth error', () => {
    const error = normalizeMissingOAuthCredentialsError(
      new Error('{"error":"invalid_token","error_description":"Missing or invalid access token"}'),
      'notion',
      false
    );

    expect((error as Error & { code?: ErrorCode }).code).toBe(ErrorCode.AUTH_ERROR);
    expect(error.message).toContain('mcp-cli auth login notion');
  });

  test('preserves static authorization errors', () => {
    const error = new Error('Unauthorized');
    const normalized = normalizeMissingOAuthCredentialsError(error, 'test', false, true);

    expect(normalized).toBe(error);
  });

  test('sanitizes OAuth login errors', () => {
    const secret =
      'error_description=attacker-controlled&code=authorization-code&state=state&token=token';
    const error = sanitizeOAuthLoginError(new Error(secret));

    expect(error.message).toBe(
      'OAuth login failed. Verify the server OAuth configuration and try again.'
    );
    expect(error.message).not.toContain(secret);
  });

  test('only adds configured headers to the MCP resource endpoint', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: input.toString(),
        headers: new Headers(init?.headers),
      });
      return new Response();
    }) as typeof fetch;

    try {
      const configuredFetch = createConfiguredFetch(new URL(config.url), {
        'X-Configured': 'value',
      });
      await configuredFetch(config.url, {
        headers: { 'X-OAuth': 'generated' },
      });
      await configuredFetch('https://auth.example.test/token', {
        headers: { 'X-OAuth': 'generated' },
      });

      expect(requests[0].headers.get('X-Configured')).toBe('value');
      expect(requests[0].headers.get('X-OAuth')).toBe('generated');
      expect(requests[1].headers.get('X-Configured')).toBeNull();
      expect(requests[1].headers.get('X-OAuth')).toBe('generated');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not forward configured headers across redirects', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: input.toString(),
        headers: new Headers(init?.headers),
      });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://other.example.test/mcp' },
        });
      }
      return new Response();
    }) as typeof fetch;

    try {
      await createConfiguredFetch(new URL(config.url), {
        Authorization: 'Bearer configured',
      })(config.url);

      expect(requests).toHaveLength(2);
      expect(requests[0].headers.get('Authorization')).toBe('Bearer configured');
      expect(requests[1].headers.get('Authorization')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
