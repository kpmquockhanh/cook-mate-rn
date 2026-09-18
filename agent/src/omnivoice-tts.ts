/**
 * A LiveKit TTS plugin backed by a local omnivoice-server.
 *
 * omnivoice-server exposes an OpenAI-compatible `/v1/audio/speech`. Requests go
 * out with `stream: true` and `response_format: "pcm"`: PCM because
 * AudioByteStream wants raw frames and a WAV header would only have to be
 * stripped back off, and streaming because the server chunks any text over
 * ~400 characters into sentences and sends each one as it finishes. Below that
 * threshold it generates the whole thing before sending a byte, so for the
 * short sentences the StreamAdapter feeds it the flag changes nothing - it only
 * pays off on an unusually long one. The PCM is always signed 16-bit
 * little-endian mono at 24 kHz, which is what the constants below encode.
 *
 * This declares itself non-streaming (`capabilities.streaming: false`) because
 * the server has no push-text socket: every synthesis is one HTTP request for
 * one finished piece of text. `Agent.ttsNode` sees that and wraps this in a
 * `tts.StreamAdapter`, which does the incremental sentence splitting of the
 * LLM's token stream and calls `synthesize()` once per sentence. That is why
 * `stream()` below throws rather than being implemented.
 */

import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  type APIConnectOptions,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

/** The server emits PCM at a fixed rate and layout; see `utils/audio.py`. */
const SAMPLE_RATE = 24_000;
const NUM_CHANNELS = 1;

const DEFAULT_BASE_URL = 'http://127.0.0.1:8880';
const DEFAULT_MODEL = 'omnivoice';

export interface OmniVoiceTTSOptions {
  /** Base URL of the omnivoice-server, without a trailing `/v1`. */
  baseURL?: string;
  /** Bearer token, if the server was started with one. Optional by default. */
  apiKey?: string;
  model?: string;
  /**
   * An OpenAI-style preset name (`alloy`, `fable`, `onyx`, ...). Ignored by the
   * server when `instructions` is set.
   */
  voice?: string;
  /**
   * Voice *design* attributes, comma separated - e.g.
   * `'female,middle-aged,moderate pitch,american accent'`. This is the server's
   * strongest control and overrides `voice`.
   */
  instructions?: string;
  /** Playback speed multiplier. 1.0 is the server default. */
  speed?: number;
  /**
   * Diffusion steps. Fewer is faster and rougher; the server defaults to 32.
   * Worth lowering on CPU, where synthesis runs at roughly half of real time and
   * so is the bulk of the delay before a reply is heard.
   */
  numStep?: number;
  /** Classifier-free guidance scale. The server defaults to 3.0. */
  guidanceScale?: number;
  /** Fixes the RNG, so the same text always produces the same audio. */
  seed?: number;
}

type ResolvedOptions = OmniVoiceTTSOptions & { baseURL: string; model: string };

export class TTS extends tts.TTS {
  label = 'omnivoice.TTS';

  #opts: ResolvedOptions;

  constructor(opts: OmniVoiceTTSOptions = {}) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: false });
    this.#opts = {
      ...opts,
      baseURL: (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      model: opts.model ?? DEFAULT_MODEL,
    };
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'omnivoice';
  }

  synthesize(
    text: string,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortSignal?: AbortSignal
  ): tts.ChunkedStream {
    return new ChunkedStream(text, this, this.#opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error(
      'omnivoice-server has no streaming-input endpoint; this TTS is wrapped in a tts.StreamAdapter instead'
    );
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  label = 'omnivoice.ChunkedStream';

  #opts: ResolvedOptions;
  #timeoutMs: number;

  constructor(
    text: string,
    ttsInstance: TTS,
    opts: ResolvedOptions,
    connOptions: APIConnectOptions,
    abortSignal?: AbortSignal
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#opts = opts;
    // The base class keeps `connOptions` private, so hold on to the only part
    // this needs. It guards the request up to the response headers, not the
    // body: the body arrives in chunks over as long as the text takes to speak.
    this.#timeoutMs = connOptions.timeoutMs;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);

    const controller = new AbortController();
    const abort = () => controller.abort();
    this.abortSignal.addEventListener('abort', abort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.#opts.apiKey) {
      headers.Authorization = `Bearer ${this.#opts.apiKey}`;
    }

    try {
      let response: Response;
      try {
        response = await fetch(`${this.#opts.baseURL}/v1/audio/speech`, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: this.#opts.model,
            input: this.inputText,
            // Streaming is PCM-only on this server; the two go together.
            stream: true,
            response_format: 'pcm',
            ...(this.#opts.voice ? { voice: this.#opts.voice } : {}),
            ...(this.#opts.instructions ? { instructions: this.#opts.instructions } : {}),
            ...(this.#opts.speed !== undefined ? { speed: this.#opts.speed } : {}),
            ...(this.#opts.numStep !== undefined ? { num_step: this.#opts.numStep } : {}),
            ...(this.#opts.guidanceScale !== undefined
              ? { guidance_scale: this.#opts.guidanceScale }
              : {}),
            ...(this.#opts.seed !== undefined ? { seed: this.#opts.seed } : {}),
          }),
        });
      } catch (err) {
        if (timedOut) {
          throw new APITimeoutError({
            message: `omnivoice-server did not respond within ${this.#timeoutMs}ms`,
          });
        }
        if (this.abortSignal.aborted) return;
        throw new APIConnectionError({
          message: `failed to reach omnivoice-server at ${this.#opts.baseURL}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }

      // Headers are in; the rest is the audio itself, which legitimately takes
      // as long as the speech does.
      clearTimeout(timer);

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw new APIStatusError({
          message: `omnivoice-server returned ${response.status}: ${detail}`,
          options: { statusCode: response.status, requestId },
        });
      }

      const reader = response.body.getReader();
      let lastFrame: AudioFrame | undefined;

      // Every frame but the last is emitted with `final: false`, so the one that
      // carries `final: true` is genuinely the end of the segment - that flag is
      // what the framework uses to close out TTS metrics.
      const sendLastFrame = (final: boolean) => {
        if (!lastFrame) return;
        this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final });
        lastFrame = undefined;
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (this.abortSignal.aborted) return;
          for (const frame of bstream.write(value)) {
            sendLastFrame(false);
            lastFrame = frame;
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }

      // `flush()` always hands back a frame, even an empty one when the byte
      // count happened to divide evenly - publishing that would be a zero-sample
      // frame on the wire.
      for (const frame of bstream.flush()) {
        if (frame.samplesPerChannel === 0) continue;
        sendLastFrame(false);
        lastFrame = frame;
      }
      sendLastFrame(true);
    } finally {
      clearTimeout(timer);
      this.abortSignal.removeEventListener('abort', abort);
    }
  }
}
