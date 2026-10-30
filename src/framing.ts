/**
 * Newline-delimited JSON over the daemon's unix socket.
 *
 * A socket read can end mid-message (or mid UTF-8 character), and `socket.write()` can
 * accept only part of a large payload, so both directions buffer: reads until a full
 * line arrives, writes until every byte is accepted (resumed from the `drain` handler).
 */

import type { Socket } from 'bun';

const encoder = new TextEncoder();

export class JsonLineSocket {
  readonly #socket: Socket<unknown>;
  readonly #decoder = new TextDecoder();
  #inbox = '';
  #outbox: Uint8Array | undefined;

  constructor(socket: Socket<unknown>) {
    this.#socket = socket;
  }

  /** Feed a received chunk; returns the complete messages it finished. */
  receive(chunk: Uint8Array): unknown[] {
    const text = this.#decoder.decode(chunk, { stream: true });
    if (!text.includes('\n')) {
      this.#inbox += text;
      return [];
    }

    const lines = `${this.#inbox}${text}`.split('\n');
    this.#inbox = lines.pop() ?? '';
    return lines.filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  }

  send(message: unknown): void {
    const bytes = encoder.encode(`${JSON.stringify(message)}\n`);
    if (this.#outbox) {
      const joined = new Uint8Array(this.#outbox.length + bytes.length);
      joined.set(this.#outbox);
      joined.set(bytes, this.#outbox.length);
      this.#outbox = joined;
    } else {
      this.#outbox = bytes;
    }
    this.flush();
  }

  /** Write whatever is still pending; call from the socket's `drain` handler. */
  flush(): void {
    while (this.#outbox) {
      const written = this.#socket.write(this.#outbox);
      if (written >= this.#outbox.length) {
        this.#outbox = undefined;
      } else {
        if (written > 0) this.#outbox = this.#outbox.subarray(written);
        return;
      }
    }
  }
}
