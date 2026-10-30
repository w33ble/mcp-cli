/**
 * Minimal stdio MCP server whose responses are far larger than one socket read:
 * 300 tools with long multi-byte descriptions, plus an `echo` tool.
 */

const tools = Array.from({ length: 300 }, (_, i) => ({
  name: `tool_${i}`,
  description: `Tool ${i}: ${'café — ✓ ünïcödé '.repeat(40)}`,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
}));

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

let buffered = '';
for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
  buffered += chunk;
  const lines = buffered.split('\n');
  buffered = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;

    if (message.method === 'initialize') {
      reply(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'large-payload', version: '1.0.0' },
      });
    } else if (message.method === 'tools/list') {
      reply(message.id, { tools });
    } else if (message.method === 'tools/call') {
      reply(message.id, { content: [{ type: 'text', text: message.params.arguments.text }] });
    } else {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`
      );
    }
  }
}

export {};
