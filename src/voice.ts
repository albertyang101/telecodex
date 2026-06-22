import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import path from "node:path";
import { copyFile, readFile, unlink } from "node:fs/promises";

export interface TranscriptionResult {
  text: string;
  backend: "qwen" | "parakeet" | "openai";
  durationMs: number;
}

export type TranscriptionBackend = "qwen" | "parakeet" | "openai";
type RequestedTranscriptionBackend = TranscriptionBackend | "auto";
type ParakeetAvailability = "available" | "missing" | "broken";

export interface TranscriptionBackendStatus {
  requested: RequestedTranscriptionBackend;
  active: TranscriptionBackend | null;
  available: TranscriptionBackend[];
}

// Minimal interface for the parakeet-coreml engine instance.
interface ParakeetEngine {
  initialize(): Promise<void>;
  transcribe(samples: Float32Array): Promise<unknown>;
}

const PARAKEET_SPECIFIER = "parakeet-coreml";
const DEFAULT_QWEN_SOCKET_PATH = "/tmp/qwen_asr.sock";
const QWEN_SOCKET_PROBE_TIMEOUT_MS = 250;
const DEFAULT_QWEN_TIMEOUT_MS = 270_000;
const DEFAULT_VOICE_TRANSCRIPTION_TIMEOUT_MS = 270_000;
const DEFAULT_QWEN_CONTEXT =
  "人名：王静。" +
  "系统/技术词：Albert、Theo、Codex、Linear、GitHub、Notion、Graphiti、Telegram、Dispatcher、Superpowers。" +
  "佛教/中文专有名词：金刚禅寺、维摩诘经、禅意、禅宗、般若、菩提。";
const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS = 120_000;
const FFMPEG_INSTALL_MESSAGE = "ffmpeg not found. Install it with: brew install ffmpeg";
const NO_BACKEND_ERROR = `Voice messages require a transcription backend.

Option 1: Use the Qwen3-ASR resident server for Chinese transcription:
  Set VOICE_TRANSCRIPTION_BACKEND=qwen and QWEN_ASR_SOCKET=/tmp/qwen_asr.sock

Option 2: Install Parakeet for local transcription (free, private, ~1.5GB download):
  npm install parakeet-coreml
Also requires ffmpeg: brew install ffmpeg

Option 3: Set OPENAI_API_KEY for OpenAI transcription:
  Add OPENAI_API_KEY=sk-... to your .env file`;

const _require = createRequire(import.meta.url);
let _importModule: (specifier: string) => Promise<unknown> = async (specifier) => _require(specifier);
let _decodeAudio: (filePath: string) => Promise<Float32Array> = decodeAudioToSamples;
let _defaultQwenSocketPath = DEFAULT_QWEN_SOCKET_PATH;
let _engine: ParakeetEngine | null = null;

export function _setImportHook(hook: (specifier: string) => Promise<unknown>): void {
  _importModule = hook;
}

export function _setDecodeHook(hook: (filePath: string) => Promise<Float32Array>): void {
  _decodeAudio = async (filePath) =>
    await withPromiseTimeout(getVoiceTranscriptionTimeoutMs(), "Parakeet audio decode", () => hook(filePath));
}

export function _setDefaultQwenSocketPathForTest(socketPath: string): void {
  _defaultQwenSocketPath = socketPath;
}

export function _resetImportHook(): void {
  _importModule = async (specifier) => _require(specifier);
  _decodeAudio = decodeAudioToSamples;
  _defaultQwenSocketPath = DEFAULT_QWEN_SOCKET_PATH;
  _engine = null;
}

export async function transcribeAudio(filePath: string): Promise<TranscriptionResult> {
  const requestedBackend = getRequestedTranscriptionBackend();

  if (requestedBackend === "qwen") {
    return await transcribeWithQwen(filePath);
  }

  if (requestedBackend === "openai") {
    return await transcribeWithOpenAI(filePath);
  }

  if (requestedBackend === "parakeet") {
    const parakeetMod = await _importModule(PARAKEET_SPECIFIER);
    return await transcribeWithParakeet(filePath, parakeetMod);
  }

  if (await isQwenAutoConfigured()) {
    return await transcribeWithQwen(filePath);
  }

  try {
    const parakeetMod = await _importModule(PARAKEET_SPECIFIER);
    return await transcribeWithParakeet(filePath, parakeetMod);
  } catch (error) {
    if (!isModuleNotFoundError(error, PARAKEET_SPECIFIER)) {
      throw error;
    }
  }

  if (hasOpenAIApiKey()) {
    return await transcribeWithOpenAI(filePath);
  }

  throw new Error(NO_BACKEND_ERROR);
}

export async function getAvailableBackends(): Promise<TranscriptionBackend[]> {
  const backends: TranscriptionBackend[] = [];

  if (await isQwenSocketAvailable()) {
    backends.push("qwen");
  }

  if ((await getParakeetAvailability()) === "available") {
    backends.push("parakeet");
  }

  if (hasOpenAIApiKey()) {
    backends.push("openai");
  }

  return backends;
}

export async function getTranscriptionBackendStatus(): Promise<TranscriptionBackendStatus> {
  const requested = getRequestedTranscriptionBackend();
  const parakeetAvailability = await getParakeetAvailability();
  const available = await buildAvailableBackends(parakeetAvailability);
  return {
    requested,
    active: resolveActiveBackend(requested, available, parakeetAvailability),
    available,
  };
}

async function buildAvailableBackends(parakeetAvailability: ParakeetAvailability): Promise<TranscriptionBackend[]> {
  const backends: TranscriptionBackend[] = [];
  if (await isQwenSocketAvailable()) {
    backends.push("qwen");
  }
  if (parakeetAvailability === "available") {
    backends.push("parakeet");
  }
  if (hasOpenAIApiKey()) {
    backends.push("openai");
  }
  return backends;
}

function resolveActiveBackend(
  requested: RequestedTranscriptionBackend,
  available: TranscriptionBackend[],
  parakeetAvailability: ParakeetAvailability,
): TranscriptionBackend | null {
  if (requested === "auto") {
    if (available.includes("qwen")) {
      return "qwen";
    }
    if (parakeetAvailability === "available") {
      return "parakeet";
    }
    if (parakeetAvailability === "broken") {
      return null;
    }
    return available.includes("openai") ? "openai" : null;
  }
  return available.includes(requested) ? requested : null;
}

async function getParakeetAvailability(): Promise<ParakeetAvailability> {
  try {
    await _importModule(PARAKEET_SPECIFIER);
    return "available";
  } catch (error) {
    return isModuleNotFoundError(error, PARAKEET_SPECIFIER) ? "missing" : "broken";
  }
}

async function transcribeWithQwen(filePath: string): Promise<TranscriptionResult> {
  const startedAt = Date.now();
  const preparedFilePath = await prepareQwenAudioPath(filePath);
  let response: Record<string, unknown>;
  try {
    response = await requestQwenAsr({
      socketPath: getQwenSocketPath(),
      request: {
        audio_path: preparedFilePath,
        language: getOptionalEnv("QWEN_ASR_LANGUAGE") ?? null,
        context: getOptionalEnv("QWEN_ASR_CONTEXT") ?? DEFAULT_QWEN_CONTEXT,
      },
      timeoutMs: getQwenTimeoutMs(),
    });
  } finally {
    if (preparedFilePath !== filePath) {
      await unlink(preparedFilePath).catch(() => {});
    }
  }

  if (!response.ok) {
    const error = typeof response.error === "string" ? response.error : "unknown error";
    throw new Error(`Qwen ASR failed: ${error}`);
  }

  if (typeof response.text !== "string") {
    throw new Error("Qwen ASR response did not include a text field");
  }

  return {
    text: response.text,
    backend: "qwen",
    durationMs: Date.now() - startedAt,
  };
}

async function prepareQwenAudioPath(filePath: string): Promise<string> {
  if (path.extname(filePath).toLowerCase() !== ".oga") {
    return filePath;
  }

  const canonicalPath = `${filePath}.ogg`;
  await copyFile(filePath, canonicalPath);
  return canonicalPath;
}

async function transcribeWithParakeet(filePath: string, parakeetMod: unknown): Promise<TranscriptionResult> {
  const startedAt = Date.now();
  const timeoutMs = getVoiceTranscriptionTimeoutMs();
  const samples = await _decodeAudio(filePath);

  if (!_engine) {
    const mod = parakeetMod as Record<string, unknown> | null;
    const ParakeetAsrEngine =
      (mod?.ParakeetAsrEngine as (new () => unknown) | undefined) ??
      ((mod?.default as Record<string, unknown> | undefined)?.ParakeetAsrEngine as (new () => unknown) | undefined);

    if (typeof ParakeetAsrEngine !== "function") {
      throw new Error("parakeet-coreml was loaded but does not expose a ParakeetAsrEngine class");
    }

    const engine = new ParakeetAsrEngine() as Record<string, unknown>;

    if (typeof engine.initialize !== "function") {
      throw new Error("parakeet-coreml was loaded but the engine does not expose initialize()");
    }

    if (typeof engine.transcribe !== "function") {
      throw new Error("parakeet-coreml was loaded but the engine does not expose transcribe(samples)");
    }

    try {
      await withPromiseTimeout(timeoutMs, "Parakeet engine initialization", () =>
        (engine.initialize as () => Promise<void>)(),
      );
      _engine = engine as unknown as ParakeetEngine;
    } catch (error) {
      _engine = null;
      throw error;
    }
  }

  let result: unknown;
  try {
    result = await withPromiseTimeout(timeoutMs, "Parakeet transcription", () => _engine!.transcribe(samples));
  } catch (error) {
    _engine = null;
    throw error;
  }
  const text = extractTranscribedText(result);
  if (text === undefined) {
    throw new Error("parakeet-coreml returned an unsupported transcription result");
  }

  const durationMs =
    typeof result === "object" && result !== null && typeof (result as { durationMs?: unknown }).durationMs === "number"
      ? (result as { durationMs: number }).durationMs
      : Date.now() - startedAt;

  return {
    text,
    backend: "parakeet",
    durationMs,
  };
}

async function transcribeWithOpenAI(filePath: string): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(NO_BACKEND_ERROR);
  }

  const startedAt = Date.now();
  const audioBuffer = await readFile(filePath);
  const ext = (path.extname(filePath) || ".ogg").slice(1).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg",
    m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
    webm: "audio/webm", flac: "audio/flac",
  };
  const mimeType = mimeTypes[ext] ?? "audio/ogg";
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType }), path.basename(filePath) || "audio.ogg");
  form.append("model", getOptionalEnv("OPENAI_TRANSCRIPTION_MODEL") ?? DEFAULT_OPENAI_TRANSCRIPTION_MODEL);

  const timeoutMs = getOpenAITranscriptionTimeoutMs();
  const payload = await withAbortTimeout(timeoutMs, "OpenAI transcription", async (signal) => {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
      signal,
    });

    if (!response.ok) {
      const errorText = (await response.text().catch(() => "")).trim();
      throw new Error(
        `OpenAI transcription failed (${response.status}): ${errorText || response.statusText || "Unknown error"}`,
      );
    }

    return (await response.json()) as { text?: unknown };
  });
  if (typeof payload.text !== "string") {
    throw new Error("OpenAI transcription response did not include a text field");
  }

  return {
    text: payload.text,
    backend: "openai",
    durationMs: Date.now() - startedAt,
  };
}

function decodeAudioToSamples(filePath: string): Promise<Float32Array> {
  return new Promise<Float32Array>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = getVoiceTranscriptionTimeoutMs();

    const ffmpeg = spawn("ffmpeg", ["-i", filePath, "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      callback();
    };

    timeout = setTimeout(() => {
      finish(() => {
        try {
          ffmpeg.kill("SIGKILL");
        } catch {
          // Best effort: the promise must still unblock even if the child already exited.
        }
        reject(new Error(`ffmpeg audio decode timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    ffmpeg.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    ffmpeg.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    ffmpeg.once("error", (error) => {
      finish(() => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(FFMPEG_INSTALL_MESSAGE));
          return;
        }
        reject(error);
      });
    });

    ffmpeg.once("close", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          const reason = stderr || (signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`);
          reject(new Error(`ffmpeg failed to decode audio: ${reason}`));
          return;
        }

        const buffer = Buffer.concat(stdoutChunks);
        if (buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
          reject(new Error("ffmpeg returned invalid float32 PCM output"));
          return;
        }

        const samples = new Float32Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
        ).slice();
        resolve(samples);
      });
    });
  });
}

function hasOpenAIApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function getRequestedTranscriptionBackend(): RequestedTranscriptionBackend {
  const raw = (process.env.VOICE_TRANSCRIPTION_BACKEND ?? "auto").trim().toLowerCase();
  const value = raw || "auto";
  if (value === "auto" || value === "qwen" || value === "parakeet" || value === "openai") {
    return value;
  }
  throw new Error("VOICE_TRANSCRIPTION_BACKEND must be one of: auto, qwen, parakeet, openai");
}

function getQwenSocketPath(): string {
  return getOptionalEnv("QWEN_ASR_SOCKET") ?? _defaultQwenSocketPath;
}

async function isQwenAutoConfigured(): Promise<boolean> {
  return await isQwenSocketAvailable();
}

async function isQwenSocketAvailable(): Promise<boolean> {
  const socketPath = getQwenSocketPath();
  if (!existsSync(socketPath)) {
    return false;
  }
  return await canConnectToUnixSocket(socketPath, QWEN_SOCKET_PROBE_TIMEOUT_MS);
}

function getQwenTimeoutMs(): number {
  const raw = getOptionalEnv("QWEN_ASR_TIMEOUT_MS");
  if (!raw) {
    return DEFAULT_QWEN_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QWEN_TIMEOUT_MS;
}

function getOpenAITranscriptionTimeoutMs(): number {
  const raw = getOptionalEnv("OPENAI_TRANSCRIPTION_TIMEOUT_MS");
  if (!raw) {
    return DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS;
}

function getVoiceTranscriptionTimeoutMs(): number {
  const raw = getOptionalEnv("VOICE_TRANSCRIPTION_TIMEOUT_MS");
  if (!raw) {
    return DEFAULT_VOICE_TRANSCRIPTION_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_VOICE_TRANSCRIPTION_TIMEOUT_MS;
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function withAbortTimeout<T>(
  timeoutMs: number,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(controller.signal), timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function withPromiseTimeout<T>(timeoutMs: number, label: string, task: () => Promise<T>): Promise<T> {
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve().then(task), timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function requestQwenAsr(options: {
  socketPath: string;
  request: Record<string, unknown>;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const socket = createConnection(options.socketPath);
    socket.setEncoding("utf8");

    const timer = setTimeout(() => {
      settle(new Error(`Qwen ASR timed out after ${options.timeoutMs}ms`));
      socket.destroy();
    }, options.timeoutMs);

    const settle = (error?: Error, payload?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve(payload ?? {});
    };

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(options.request)}\n`);
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) {
        return;
      }
      const line = buffer.split("\n", 1)[0]?.trim() ?? "";
      try {
        const payload = JSON.parse(line) as unknown;
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          settle(new Error(`Qwen ASR returned non-object response: ${typeof payload}`));
          return;
        }
        settle(undefined, payload as Record<string, unknown>);
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      } finally {
        socket.end();
      }
    });

    socket.once("error", (error) => {
      settle(error);
    });

    socket.once("close", () => {
      if (!settled) {
        settle(new Error("Qwen ASR closed the socket without a response"));
      }
    });
  });
}

function canConnectToUnixSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      settle(false);
      socket.destroy();
    }, timeoutMs);

    const settle = (available: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(available);
    };

    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function extractTranscribedText(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result;
  }

  if (typeof result === "object" && result !== null && typeof (result as { text?: unknown }).text === "string") {
    return (result as { text: string }).text;
  }

  return undefined;
}

function isModuleNotFoundError(error: unknown, specifier: string): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    const message = error instanceof Error ? error.message : String(error);
    // Only treat as "not installed" if the message references the specific package.
    // A broken transitive dependency (e.g. missing native addon) should surface as a real error.
    return !message || message.includes(specifier);
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(`Cannot find package '${specifier}'`) ||
    message.includes(`Cannot find module '${specifier}'`) ||
    message.includes(`Cannot resolve module '${specifier}'`)
  );
}
