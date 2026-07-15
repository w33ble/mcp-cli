import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredFetch } from '../src/client';
import {
  createNonInteractiveOAuthProvider,
  getOAuthIdentity,
  normalizeMissingOAuthCredentialsError,
  sanitizeOAuthLoginError,
} from '../src/oauth';
import { ErrorCode } from '../src/errors';

const config = { url: 'https://mcp.example.test/mcp' };
const identity = getOAuthIdentity('/tmp/oauth-test', 'test', config);
const credentialFile = join(
  homedir(),
  '.config',
  'mcp',
  'oauth',
  `${identity}.json`,
);

afterEach(async () => {
  await rm(credentialFile, { force: true });
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
      }),
    );

    const provider = await createNonInteractiveOAuthProvider(
      'test',
      config,
      '/tmp/oauth-test',
    );

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
      }),
    );

    const provider = await createNonInteractiveOAuthProvider(
      'test',
      config,
      '/tmp/oauth-test',
    );
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
      false,
    );

    expect((error as Error & { code?: ErrorCode }).code).toBe(
      ErrorCode.AUTH_ERROR,
    );
    expect(error.message).toContain('mcp-cli auth login test');
  });

  test('turns OAuth invalid_token responses into an auth error', () => {
    const error = normalizeMissingOAuthCredentialsError(
      new Error('{"error":"invalid_token","error_description":"Missing or invalid access token"}'),
      'notion',
      false,
    );

    expect((error as Error & { code?: ErrorCode }).code).toBe(
      ErrorCode.AUTH_ERROR,
    );
    expect(error.message).toContain('mcp-cli auth login notion');
  });

  test('preserves static authorization errors', () => {
    const error = new Error('Unauthorized');
    const normalized = normalizeMissingOAuthCredentialsError(
      error,
      'test',
      false,
      true,
    );

    expect(normalized).toBe(error);
  });

  test('sanitizes OAuth login errors', () => {
    const secret =
      'error_description=attacker-controlled&code=authorization-code&state=state&token=token';
    const error = sanitizeOAuthLoginError(new Error(secret));

    expect(error.message).toBe(
      'OAuth login failed. Verify the server OAuth configuration and try again.',
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
      const configuredFetch = createConfiguredFetch(
        new URL(config.url),
        { 'X-Configured': 'value' },
      );
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
      expect(requests[0].headers.get('Authorization')).toBe(
        'Bearer configured',
      );
      expect(requests[1].headers.get('Authorization')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
