import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  VOICE_TRANSCRIPTION_BACKEND: process.env.VOICE_TRANSCRIPTION_BACKEND,
  QWEN_ASR_SOCKET: process.env.QWEN_ASR_SOCKET,
  QWEN_ASR_CONTEXT: process.env.QWEN_ASR_CONTEXT,
  QWEN_ASR_LANGUAGE: process.env.QWEN_ASR_LANGUAGE,
  QWEN_ASR_TIMEOUT_MS: process.env.QWEN_ASR_TIMEOUT_MS,
  OPENAI_TRANSCRIPTION_MODEL: process.env.OPENAI_TRANSCRIPTION_MODEL,
  VOICE_TRANSCRIPTION_TIMEOUT_MS: process.env.VOICE_TRANSCRIPTION_TIMEOUT_MS,
};

function createSpawnMock(onSpawn: (child: FakeChildProcess) => void) {
  return vi.fn(() => {
    const child = new EventEmitter() as FakeChildProcess;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    process.nextTick(() => onSpawn(child));
    return child;
  });
}

async function importVoiceWithSpawn(spawnMock: ReturnType<typeof createSpawnMock>) {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
  process.env.VOICE_TRANSCRIPTION_BACKEND = "parakeet";
  process.env.QWEN_ASR_SOCKET = "/tmp/telecodex-test-missing-qwen-asr.sock";
  return await import("../src/voice.js");
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
  vi.unstubAllGlobals();
  restoreEnv("OPENAI_API_KEY");
  restoreEnv("VOICE_TRANSCRIPTION_BACKEND");
  restoreEnv("QWEN_ASR_SOCKET");
  restoreEnv("QWEN_ASR_CONTEXT");
  restoreEnv("QWEN_ASR_LANGUAGE");
  restoreEnv("QWEN_ASR_TIMEOUT_MS");
  restoreEnv("OPENAI_TRANSCRIPTION_MODEL");
  restoreEnv("VOICE_TRANSCRIPTION_TIMEOUT_MS");
});

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("voice decoding", () => {
  it("decodes ffmpeg float32 output into samples for parakeet", async () => {
    const expectedSamples = new Float32Array([0.25, -0.5, 0.75]);
    const spawnMock = createSpawnMock((child) => {
      child.stdout.emit("data", Buffer.from(expectedSamples.buffer.slice(0)));
      child.emit("close", 0, null);
    });
    const voice = await importVoiceWithSpawn(spawnMock);

    voice._setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(samples: Float32Array): Promise<{ text: string; durationMs: number }> {
          expect(Array.from(samples)).toEqual(Array.from(expectedSamples));
          return { text: "decoded locally", durationMs: 7 };
        }
      },
    }));

    const result = await voice.transcribeAudio("/tmp/sample.ogg");

    expect(spawnMock).toHaveBeenCalledWith(
      "ffmpeg",
      ["-i", "/tmp/sample.ogg", "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(result).toMatchObject({
      text: "decoded locally",
      backend: "parakeet",
      durationMs: 7,
    });
  });

  it("surfaces ffmpeg decode failures", async () => {
    const spawnMock = createSpawnMock((child) => {
      child.stderr.emit("data", Buffer.from("bad input file"));
      child.emit("close", 1, null);
    });
    const voice = await importVoiceWithSpawn(spawnMock);

    voice._setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "unused", durationMs: 7 };
        }
      },
    }));

    await expect(voice.transcribeAudio("/tmp/bad.ogg")).rejects.toThrow(
      "ffmpeg failed to decode audio: bad input file",
    );
  });

  it("rejects invalid ffmpeg PCM output", async () => {
    const spawnMock = createSpawnMock((child) => {
      child.stdout.emit("data", Buffer.from([1, 2, 3]));
      child.emit("close", 0, null);
    });
    const voice = await importVoiceWithSpawn(spawnMock);

    voice._setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "unused", durationMs: 7 };
        }
      },
    }));

    await expect(voice.transcribeAudio("/tmp/bad-pcm.ogg")).rejects.toThrow(
      "ffmpeg returned invalid float32 PCM output",
    );
  });

  it("surfaces a friendly error when ffmpeg cannot be spawned", async () => {
    const spawnMock = createSpawnMock((child) => {
      child.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
    });
    const voice = await importVoiceWithSpawn(spawnMock);

    voice._setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "unused", durationMs: 7 };
        }
      },
    }));

    await expect(voice.transcribeAudio("/tmp/missing.ogg")).rejects.toThrow("brew install ffmpeg");
  });

  it("kills ffmpeg when parakeet audio decode times out", async () => {
    process.env.VOICE_TRANSCRIPTION_TIMEOUT_MS = "5";
    let childProcess: FakeChildProcess | undefined;
    const spawnMock = createSpawnMock((child) => {
      childProcess = child;
    });
    const voice = await importVoiceWithSpawn(spawnMock);

    voice._setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "unused", durationMs: 7 };
        }
      },
    }));

    const result = await Promise.race([
      voice.transcribeAudio("/tmp/stuck.ogg").then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      delay(50).then(() => "timed-out"),
    ]);

    expect(result).toContain("ffmpeg audio decode timed out after 5ms");
    expect(childProcess?.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
