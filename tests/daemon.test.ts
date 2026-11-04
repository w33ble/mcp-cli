import { describe, expect, test } from 'bun:test';

import { type DaemonResponse, flushMessages, readMessages, writeMessage } from '../src/daemon';

/** Socket that accepts at most `capacity` bytes per write, like a full kernel buffer */
function throttledSocket(capacity: number) {
  const received: Buffer[] = [];
  return {
    received,
    write(data: Uint8Array): number {
      const accepted = data.subarray(0, capacity);
      received.push(Buffer.from(accepted));
      return accepted.length;
    },
  };
}

describe('daemon socket framing', () => {
  const response: DaemonResponse = {
    id: '1',
    success: true,
    data: {
      tools: Array.from({ length: 200 }, (_, i) => ({ name: `tool_${i}`, note: 'ünïcødé' })),
    },
  };

  test('reassembles a message split across chunks, including inside a multibyte character', () => {
    const bytes = Buffer.from(`${JSON.stringify(response)}\n`);
    const splitInsideChar = bytes.indexOf(Buffer.from('ü')) + 1;
    const socket = {};

    expect(readMessages(socket, bytes.subarray(0, splitInsideChar))).toEqual([]);
    expect(readMessages(socket, bytes.subarray(splitInsideChar, splitInsideChar + 100))).toEqual(
      []
    );
    const [message] = readMessages(socket, bytes.subarray(splitInsideChar + 100));

    expect(JSON.parse(message)).toEqual(response);
  });

  test('returns each message when one chunk holds several', () => {
    const socket = {};
    const chunk = Buffer.from('{"id":"a"}\n{"id":"b"}\n{"id":');

    expect(readMessages(socket, chunk)).toEqual(['{"id":"a"}', '{"id":"b"}']);
    expect(readMessages(socket, Buffer.from('"c"}\n'))).toEqual(['{"id":"c"}']);
  });

  test('delivers every byte when the socket applies backpressure', () => {
    const socket = throttledSocket(1024);

    writeMessage(socket, response);
    for (let drains = 0; drains < 1000; drains++) flushMessages(socket);

    const [message] = readMessages({}, Buffer.concat(socket.received));
    expect(JSON.parse(message)).toEqual(response);
  });

  test('queues a second message behind a partially written one', () => {
    const socket = throttledSocket(10);
    const second: DaemonResponse = { id: '2', success: true, data: 'pong' };

    writeMessage(socket, response);
    writeMessage(socket, second);
    for (let drains = 0; drains < 10_000; drains++) flushMessages(socket);

    const messages = readMessages({}, Buffer.concat(socket.received)).map((m) => JSON.parse(m));
    expect(messages).toEqual([response, second]);
  });
});
