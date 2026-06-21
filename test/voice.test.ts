import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetImportHook,
  _setDecodeHook,
  _setDefaultQwenSocketPathForTest,
  _setImportHook,
  getAvailableBackends,
  getTranscriptionBackendStatus,
  transcribeAudio,
} from "../src/voice.js";

describe("voice transcription", () => {
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  const originalVoiceBackend = process.env.VOICE_TRANSCRIPTION_BACKEND;
  const originalQwenSocket = process.env.QWEN_ASR_SOCKET;
  const originalQwenContext = process.env.QWEN_ASR_CONTEXT;
  const originalQwenLanguage = process.env.QWEN_ASR_LANGUAGE;
  const originalOpenAITranscriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL;
  const originalQwenTimeoutMs = process.env.QWEN_ASR_TIMEOUT_MS;
  let tempDir: string;
  let audioPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-voice-"));
    audioPath = path.join(tempDir, "sample.ogg");
    writeFileSync(audioPath, Buffer.from("audio"));
    delete process.env.OPENAI_API_KEY;
    delete process.env.VOICE_TRANSCRIPTION_BACKEND;
    process.env.QWEN_ASR_SOCKET = path.join(tempDir, "missing-qwen-asr.sock");
    delete process.env.QWEN_ASR_CONTEXT;
    delete process.env.QWEN_ASR_LANGUAGE;
    delete process.env.OPENAI_TRANSCRIPTION_MODEL;
    delete process.env.QWEN_ASR_TIMEOUT_MS;
    _resetImportHook();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    _resetImportHook();
    vi.unstubAllGlobals();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
    if (originalVoiceBackend === undefined) {
      delete process.env.VOICE_TRANSCRIPTION_BACKEND;
    } else {
      process.env.VOICE_TRANSCRIPTION_BACKEND = originalVoiceBackend;
    }
    if (originalQwenSocket === undefined) {
      delete process.env.QWEN_ASR_SOCKET;
    } else {
      process.env.QWEN_ASR_SOCKET = originalQwenSocket;
    }
    if (originalQwenContext === undefined) {
      delete process.env.QWEN_ASR_CONTEXT;
    } else {
      process.env.QWEN_ASR_CONTEXT = originalQwenContext;
    }
    if (originalQwenLanguage === undefined) {
      delete process.env.QWEN_ASR_LANGUAGE;
    } else {
      process.env.QWEN_ASR_LANGUAGE = originalQwenLanguage;
    }
    if (originalOpenAITranscriptionModel === undefined) {
      delete process.env.OPENAI_TRANSCRIPTION_MODEL;
    } else {
      process.env.OPENAI_TRANSCRIPTION_MODEL = originalOpenAITranscriptionModel;
    }
    if (originalQwenTimeoutMs === undefined) {
      delete process.env.QWEN_ASR_TIMEOUT_MS;
    } else {
      process.env.QWEN_ASR_TIMEOUT_MS = originalQwenTimeoutMs;
    }
  });

  async function startQwenServerWithHandler(
    handler: (line: string, socket: import("node:net").Socket) => void,
  ): Promise<{ socketPath: string; requests: unknown[]; close: () => Promise<void> }> {
    const socketPath = path.join(tempDir, "qwen-asr.sock");
    const requests: unknown[] = [];
    const server: Server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) {
          return;
        }
        const line = buffer.split("\n", 1)[0] ?? "";
        requests.push(JSON.parse(line));
        handler(line, socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    return {
      socketPath,
      requests,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
      }),
    };
  }

  async function startQwenServer(
    response: { ok: boolean; text?: string; language?: string; error?: string },
  ): Promise<{ socketPath: string; requests: unknown[]; close: () => Promise<void> }> {
    return await startQwenServerWithHandler((_line, socket) => {
      socket.end(`${JSON.stringify(response)}\n`);
    });
  }

  async function expectQwenFailureWithoutParakeetFallback(expectedMessage: string | RegExp): Promise<void> {
    _setImportHook(async () => {
      throw new Error("parakeet should not be imported after Qwen failure");
    });

    await expect(transcribeAudio(audioPath)).rejects.toThrow(expectedMessage);
  }

  it("uses parakeet when available", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        return {
          ParakeetAsrEngine: class {
            async initialize(): Promise<void> {}
            async transcribe(samples: Float32Array): Promise<{ text: string; durationMs: number }> {
              expect(samples).toBeInstanceOf(Float32Array);
              expect(samples.length).toBe(100);
              return { text: "hello world", durationMs: 5 };
            }
          },
        };
      }
      throw new Error(`unexpected import: ${specifier}`);
    });

    const result = await transcribeAudio(audioPath);

    expect(result.text).toBe("hello world");
    expect(result.backend).toBe("parakeet");
    expect(result.durationMs).toBe(5);
  });

  it("falls back to OpenAI when parakeet is unavailable", async () => {
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-coreml'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "cloud transcript" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeAudio(audioPath);

    expect(result).toMatchObject({
      text: "cloud transcript",
      backend: "openai",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer sk-test" },
        body: expect.any(FormData),
      }),
    );
  });

  it("uses Qwen resident ASR when VOICE_TRANSCRIPTION_BACKEND=qwen", async () => {
    const qwen = await startQwenServer({ ok: true, text: "你听得到我说话吗", language: "Chinese" });
    process.env.VOICE_TRANSCRIPTION_BACKEND = "qwen";
    process.env.QWEN_ASR_SOCKET = qwen.socketPath;
    _setImportHook(async () => {
      throw new Error("parakeet should not be imported");
    });

    try {
      const result = await transcribeAudio(audioPath);

      expect(result).toMatchObject({
        text: "你听得到我说话吗",
        backend: "qwen",
      });
      expect(qwen.requests).toHaveLength(1);
      expect(qwen.requests[0]).toMatchObject({
        audio_path: audioPath,
        context: expect.stringContaining("王静"),
      });
    } finally {
      await qwen.close();
    }
  });

  it("includes core system hotwords in the default Qwen context for mixed Chinese/English speech", async () => {
    const qwen = await startQwenServer({ ok: true, text: "Codex能看到Linear和GitHub吗", language: "Chinese" });
    process.env.VOICE_TRANSCRIPTION_BACKEND = "qwen";
    process.env.QWEN_ASR_SOCKET = qwen.socketPath;
    _setImportHook(async () => {
      throw new Error("parakeet should not be imported");
    });

    try {
      await transcribeAudio(audioPath);

      expect(qwen.requests).toHaveLength(1);
      const context = (qwen.requests[0] as { context?: unknown }).context;
      expect(context).toEqual(expect.stringContaining("Codex"));
      expect(context).toEqual(expect.stringContaining("Linear"));
      expect(context).toEqual(expect.stringContaining("GitHub"));
      expect(context).toEqual(expect.stringContaining("Notion"));
      expect(context).toEqual(expect.stringContaining("Graphiti"));
      expect(context).toEqual(expect.stringContaining("Theo"));
    } finally {
      await qwen.close();
    }
  });

  it("canonicalizes Telegram .oga voice files to .ogg before sending them to Qwen", async () => {
    const telegramVoicePath = path.join(tempDir, "telegram-voice.oga");
    writeFileSync(telegramVoicePath, Buffer.from("ogg-opus-audio"));
    let requestedAudioPath: string | undefined;
    let requestedAudioPathExisted = false;
    const qwen = await startQwenServerWithHandler((line, socket) => {
      const request = JSON.parse(line) as { audio_path?: unknown };
      requestedAudioPath = String(request.audio_path);
      requestedAudioPathExisted = existsSync(requestedAudioPath);
      socket.end(`${JSON.stringify({ ok: true, text: "你听得到我说话吗", language: "Chinese" })}\n`);
    });
    process.env.VOICE_TRANSCRIPTION_BACKEND = "qwen";
    process.env.QWEN_ASR_SOCKET = qwen.socketPath;
    _setImportHook(async () => {
      throw new Error("parakeet should not be imported");
    });

    try {
      const result = await transcribeAudio(telegramVoicePath);

      expect(result).toMatchObject({
        text: "你听得到我说话吗",
        backend: "qwen",
      });
      expect(requestedAudioPath).toBeDefined();
      expect(path.extname(requestedAudioPath!)).toBe(".ogg");
      expect(requestedAudioPath).not.toBe(telegramVoicePath);
      expect(requestedAudioPathExisted).toBe(true);
      expect(existsSync(requestedAudioPath!)).toBe(false);
    } finally {
      await qwen.close();
    }
  });

  it("auto prefers Qwen resident ASR before parakeet when the socket is configured", async () => {
    const qwen = await startQwenServer({ ok: true, text: "自动优先千问", language: "Chinese" });
    process.env.QWEN_ASR_SOCKET = qwen.socketPath;
    _setImportHook(async () => {
      throw new Error("parakeet should not be imported when qwen is reachable");
    });

    try {
      const result = await transcribeAudio(audioPath);

      expect(result).toMatchObject({
        text: "自动优先千问",
        backend: "qwen",
      });
      expect(qwen.requests).toHaveLength(1);
    } finally {
      await qwen.close();
    }
  });

  it("auto prefers Qwen resident ASR before parakeet when the default socket exists", async () => {
    const qwen = await startQwenServer({ ok: true, text: "默认千问优先", language: "Chinese" });
    delete process.env.QWEN_ASR_SOCKET;
    _setDefaultQwenSocketPathForTest(qwen.socketPath);
    _setImportHook(async () => {
      throw new Error("parakeet should not be imported when default qwen socket is reachable");
    });

    try {
      const result = await transcribeAudio(audioPath);

      expect(result).toMatchObject({
        text: "默认千问优先",
        backend: "qwen",
      });
      expect(qwen.requests).toHaveLength(1);
    } finally {
      await qwen.close();
    }
  });

  it("reports Qwen as available when its default socket is reachable", async () => {
    const qwen = await startQwenServer({ ok: true, text: "unused", language: "Chinese" });
    delete process.env.QWEN_ASR_SOCKET;
    _setDefaultQwenSocketPathForTest(qwen.socketPath);
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-coreml'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });

    try {
      await expect(getAvailableBackends()).resolves.toEqual(["qwen"]);
    } finally {
      await qwen.close();
    }
  });

  it("reports the explicit active backend separately from available backends", async () => {
    const qwen = await startQwenServer({ ok: true, text: "unused", language: "Chinese" });
    process.env.QWEN_ASR_SOCKET = qwen.socketPath;
    process.env.VOICE_TRANSCRIPTION_BACKEND = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "unused", durationMs: 1 };
        }
      },
    }));

    try {
      await expect(getTranscriptionBackendStatus()).resolves.toEqual({
        requested: "openai",
        active: "openai",
        available: ["qwen", "parakeet", "openai"],
      });
    } finally {
      await qwen.close();
    }
  });

  it("reports an unavailable explicit backend without pretending another backend is active", async () => {
    process.env.VOICE_TRANSCRIPTION_BACKEND = "qwen";
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "unused", durationMs: 1 };
        }
      },
    }));

    await expect(getTranscriptionBackendStatus()).resolves.toEqual({
      requested: "qwen",
      active: null,
      available: ["parakeet"],
    });
  });

  it("does not report OpenAI active in auto mode when parakeet is broken", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    _setImportHook(async () => {
      const error = new Error("Cannot find module '/native/parakeet/binding.node'") as Error & { code?: string };
      error.code = "MODULE_NOT_FOUND";
      throw error;
    });

    await expect(getTranscriptionBackendStatus()).resolves.toEqual({
      requested: "auto",
      active: null,
      available: ["openai"],
    });
    await expect(transcribeAudio(audioPath)).rejects.toThrow("binding.node");
  });

  it("does not report Qwen as available when no configured or default socket is reachable", async () => {
    const qwen = await startQwenServer({ ok: true, text: "unused", language: "Chinese" });
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-coreml'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });

    try {
      await expect(getAvailableBackends()).resolves.toEqual([]);

      process.env.QWEN_ASR_SOCKET = qwen.socketPath;

      await expect(getAvailableBackends()).resolves.toEqual(["qwen"]);
    } finally {
      await qwen.close();
    }
  });

  it("does not treat a stale Qwen socket path as available in auto mode", async () => {
    const staleSocketPath = path.join(tempDir, "stale-qwen-asr.sock");
    writeFileSync(staleSocketPath, Buffer.from("not a unix socket"));
    process.env.QWEN_ASR_SOCKET = staleSocketPath;
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-coreml'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });

    await expect(getTranscriptionBackendStatus()).resolves.toEqual({
      requested: "auto",
      active: null,
      available: [],
    });
    await expect(transcribeAudio(audioPath)).rejects.toThrow("Voice messages require a transcription backend.");
  });

  it("fails closed when Qwen returns ok:false and does not fall back to parakeet", async () => {
    const qwen = await startQwenServer({ ok: false, error: "generate failed" });
    process.env.VOICE_TRANSCRIPTION_BACKEND = "qwen";
    process.env.QWEN_ASR_SOCKET = qwen.socketPath;

    try {
      await expectQwenFailureWithoutParakeetFallback("Qwen ASR failed: generate failed");
    } finally {
      await qwen.close();
    }
  });

  it("fails closed when Qwen returns no text field and does not fall back to parakeet", async () => {
    const qwen = await startQwenServer({ ok: true, language: "Chinese" });
    process.env.VOICE_TRANSCRIPTION_BACKEND = "qwen";
    process.env.QWEN_ASR_SOCKET = qwen.socketPath;

    try {
      await expectQwenFailureWithoutParakeetFallback("Qwen ASR response did not include a text field");
    } finally {
      await qwen.close();
    }
  });

  it("fails closed when Qwen returns invalid JSON and does not fall back to parakeet", async () => {
    const qwen = await startQwenServerWithHandler((_line, socket) => {
      socket.end("not-json\n");
    });
    process.env.VOICE_TRANSCRIPTION_BACKEND = "qwen";
    process.env.QWEN_ASR_SOCKET = qwen.socketPath;

    try {
      await expectQwenFailureWithoutParakeetFallback(/Unexpected token|JSON Parse error|not-json/);
    } finally {
      await qwen.close();
    }
  });

  it("fails closed when Qwen closes without a response and does not fall back to parakeet", async () => {
    const qwen = await startQwenServerWithHandler((_line, socket) => {
      socket.end();
    });
    process.env.VOICE_TRANSCRIPTION_BACKEND = "qwen";
    process.env.QWEN_ASR_SOCKET = qwen.socketPath;

    try {
      await expectQwenFailureWithoutParakeetFallback("Qwen ASR closed the socket without a response");
    } finally {
      await qwen.close();
    }
  });

  it("fails closed when Qwen times out and does not fall back to parakeet", async () => {
    const qwen = await startQwenServerWithHandler(() => {
      // Keep the socket open so the client timeout owns the failure path.
    });
    process.env.VOICE_TRANSCRIPTION_BACKEND = "qwen";
    process.env.QWEN_ASR_SOCKET = qwen.socketPath;
    process.env.QWEN_ASR_TIMEOUT_MS = "5";

    try {
      await expectQwenFailureWithoutParakeetFallback("Qwen ASR timed out after 5ms");
    } finally {
      await qwen.close();
    }
  });

  it("uses OpenAI when VOICE_TRANSCRIPTION_BACKEND=openai even if parakeet is available", async () => {
    process.env.VOICE_TRANSCRIPTION_BACKEND = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "中文转写" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {
          throw new Error("parakeet should not be initialized");
        }
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          throw new Error("parakeet should not transcribe");
        }
      },
    }));

    const result = await transcribeAudio(audioPath);

    expect(result).toMatchObject({
      text: "中文转写",
      backend: "openai",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends the configured OpenAI transcription model", async () => {
    process.env.VOICE_TRANSCRIPTION_BACKEND = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "configured model transcript" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeAudio(audioPath);

    expect(result.text).toBe("configured model transcript");
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get("model")).toBe("gpt-4o-mini-transcribe");
  });

  it("fails closed when VOICE_TRANSCRIPTION_BACKEND=openai but OPENAI_API_KEY is missing", async () => {
    process.env.VOICE_TRANSCRIPTION_BACKEND = "openai";
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {
          throw new Error("parakeet should not be initialized");
        }
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          throw new Error("parakeet should not transcribe");
        }
      },
    }));

    await expect(transcribeAudio(audioPath)).rejects.toThrow("OPENAI_API_KEY");
  });

  it("uses parakeet when VOICE_TRANSCRIPTION_BACKEND=parakeet even if OpenAI is configured", async () => {
    process.env.VOICE_TRANSCRIPTION_BACKEND = "parakeet";
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "local transcript", durationMs: 5 };
        }
      },
    }));

    const result = await transcribeAudio(audioPath);

    expect(result).toMatchObject({
      text: "local transcript",
      backend: "parakeet",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a helpful error when no backend is available", async () => {
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-coreml'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });

    await expect(transcribeAudio(audioPath)).rejects.toThrow("Voice messages require a transcription backend.");
    await expect(transcribeAudio(audioPath)).rejects.toThrow("npm install parakeet-coreml");
    await expect(transcribeAudio(audioPath)).rejects.toThrow("brew install ffmpeg");
    await expect(transcribeAudio(audioPath)).rejects.toThrow("OPENAI_API_KEY=sk-");
  });

  it("surfaces OpenAI API errors", async () => {
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-coreml'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "server exploded",
      }),
    );

    await expect(transcribeAudio(audioPath)).rejects.toThrow(
      "OpenAI transcription failed (500): server exploded",
    );
  });

  it("rethrows parakeet runtime errors instead of falling through", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<never> {
          throw new Error("GPU failure");
        }
      },
    }));
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeAudio(audioPath)).rejects.toThrow("GPU failure");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports available backends", async () => {
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-coreml") {
        return {
          ParakeetAsrEngine: class {
            async initialize(): Promise<void> {}
            async transcribe(): Promise<{ text: string; durationMs: number }> {
              return { text: "ignored", durationMs: 5 };
            }
          },
        };
      }
      throw new Error(`unexpected import: ${specifier}`);
    });
    process.env.OPENAI_API_KEY = "sk-test";

    await expect(getAvailableBackends()).resolves.toEqual(["parakeet", "openai"]);

    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-coreml'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
    delete process.env.OPENAI_API_KEY;

    await expect(getAvailableBackends()).resolves.toEqual([]);
  });

  it("allows empty transcripts without throwing", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "", durationMs: 5 };
        }
      },
    }));

    const result = await transcribeAudio(audioPath);

    expect(result).toMatchObject({
      text: "",
      backend: "parakeet",
      durationMs: 5,
    });
  });

  it("falls back to elapsed duration when parakeet omits durationMs", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string }> {
          return { text: "default duration transcript" };
        }
      },
    }));

    const result = await transcribeAudio(audioPath);

    expect(result.text).toBe("default duration transcript");
    expect(result.backend).toBe("parakeet");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws when OpenAI response is missing text field", async () => {
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-coreml'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: "ok" }),
      }),
    );

    await expect(transcribeAudio(audioPath)).rejects.toThrow(
      "OpenAI transcription response did not include a text field",
    );
  });

  it("throws when fetch rejects entirely (network failure)", async () => {
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-coreml'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unreachable")),
    );

    await expect(transcribeAudio(audioPath)).rejects.toThrow("network unreachable");
  });

  it("surfaces broken parakeet transitive dependency instead of falling through", async () => {
    _setImportHook(async () => {
      const error = new Error("Cannot find module '/usr/lib/node_modules/napi-bindings/build/Release/binding.node'") as Error & { code?: string };
      error.code = "MODULE_NOT_FOUND";
      throw error;
    });
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeAudio(audioPath)).rejects.toThrow("binding.node");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a helpful error when ffmpeg is missing", async () => {
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "unused", durationMs: 5 };
        }
      },
    }));
    _setDecodeHook(async () => {
      throw new Error("ffmpeg not found. Install it with: brew install ffmpeg");
    });

    await expect(transcribeAudio(audioPath)).rejects.toThrow("brew install ffmpeg");
  });

  it("propagates parakeet engine initialization failures", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {
          throw new Error("model download failed");
        }
        async transcribe(): Promise<{ text: string; durationMs: number }> {
          return { text: "unused", durationMs: 5 };
        }
      },
    }));

    await expect(transcribeAudio(audioPath)).rejects.toThrow("model download failed");
  });

  it("throws when parakeet-coreml does not expose ParakeetAsrEngine", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({}));

    await expect(transcribeAudio(audioPath)).rejects.toThrow("does not expose a ParakeetAsrEngine class");
  });

  it("throws when the parakeet engine does not expose transcribe", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
      },
    }));

    await expect(transcribeAudio(audioPath)).rejects.toThrow("does not expose transcribe(samples)");
  });

  it("throws when parakeet returns an unsupported transcription result", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      ParakeetAsrEngine: class {
        async initialize(): Promise<void> {}
        async transcribe(): Promise<{ segments: [] }> {
          return { segments: [] };
        }
      },
    }));

    await expect(transcribeAudio(audioPath)).rejects.toThrow("unsupported transcription result");
  });

  it("resolves ParakeetAsrEngine from parakeet-coreml default export", async () => {
    _setDecodeHook(async () => new Float32Array(100));
    _setImportHook(async () => ({
      default: {
        ParakeetAsrEngine: class {
          async initialize(): Promise<void> {}
          async transcribe(): Promise<{ text: string; durationMs: number }> {
            return { text: "default export transcript", durationMs: 3 };
          }
        },
      },
    }));

    const result = await transcribeAudio(audioPath);

    expect(result.text).toBe("default export transcript");
    expect(result.backend).toBe("parakeet");
    expect(result.durationMs).toBe(3);
  });
});
