import { Response } from 'express';

/**
 * Server-sent events for the streaming AI routes.
 *
 * Three things here exist because of the proxy rather than the browser:
 *
 *  · `X-Accel-Buffering: no` tells nginx not to buffer this response. Without
 *    it nginx collects the whole stream and hands it over at the end, which
 *    turns streaming into a slower version of not streaming.
 *  · The heartbeat. nginx gives up on an upstream that has said nothing for
 *    `proxy_read_timeout`, and a reasoning model can spend well over a minute
 *    thinking before its first token. A comment line every fifteen seconds is
 *    invisible to EventSource and keeps that timer from ever expiring.
 *  · `Connection: keep-alive` and the disabled compression, so nothing in the
 *    path decides to accumulate a buffer's worth before passing it on.
 */

const HEARTBEAT_MS = 15_000;

export interface SseChannel {
  /** One named event with a JSON payload. */
  send(event: string, data: unknown): void;
  /** Close the stream cleanly. Safe to call twice. */
  end(): void;
  /** True once the client has hung up — stop working when it is. */
  closed(): boolean;
}

export function openSse(res: Response): SseChannel {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Some proxies won't forward anything until a first chunk exists.
  res.write(': open\n\n');

  let done = false;
  const beat = setInterval(() => {
    if (done) return;
    res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(beat);
  };

  res.on('close', finish);

  return {
    send(event, data) {
      if (done) return;
      // Every payload is JSON on one line, so a body containing newlines (which
      // every model answer does) can't be read as an SSE field separator.
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      if (done) return;
      finish();
      res.end();
    },
    closed: () => done,
  };
}
