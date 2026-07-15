import { getServerConfig, isHttpServer, loadConfig } from '../config.js';
import { invalidateDaemon } from '../daemon-client.js';
import { ErrorCode, formatCliError } from '../errors.js';
import { getOAuthIdentity, login, logout, oauthStatus } from '../oauth.js';

export async function authCommand(
  action: 'login' | 'logout' | 'status',
  serverName: string,
  configPath?: string,
): Promise<void> {
  const config = await loadConfig(configPath);
  const server = getServerConfig(config, serverName);
  if (!isHttpServer(server)) {
    throw new Error(
      formatCliError({
        code: ErrorCode.CLIENT_ERROR,
        type: 'AUTH_UNSUPPORTED_TRANSPORT',
        message: `Server "${serverName}" is not a Streamable HTTP server`,
        suggestion: 'OAuth is only supported for servers configured with a URL',
      }),
    );
  }

  if (action === 'login') {
    await invalidateDaemon(
      getOAuthIdentity(config.configPath, serverName, server),
    );
    await login(serverName, server, config.configPath);
    console.log(`Authenticated with ${serverName}`);
    return;
  }
  if (action === 'logout') {
    const removed = await logout(serverName, server, config.configPath);
    await invalidateDaemon(
      getOAuthIdentity(config.configPath, serverName, server),
    );
    console.log(
      removed
        ? `Logged out from ${serverName}`
        : `No credentials stored for ${serverName}`,
    );
    return;
  }
  console.log(
    (await oauthStatus(serverName, server, config.configPath))
      ? 'authenticated'
      : 'not authenticated',
  );
}
