import { describe, expect, it } from "vitest";

import { formatTelegramIngressAuditLine } from "../src/bot.js";

describe("formatTelegramIngressAuditLine", () => {
  it("records routing facts without logging message text", () => {
    const line = formatTelegramIngressAuditLine(
      {
        update: { update_id: 12345 },
        from: { id: 6872058088 },
        chat: { id: 6872058088, type: "private" },
        message: { message_id: 77, text: "secret user text" },
      } as never,
      true,
    );

    expect(line).toBe(
      "Telegram ingress update_id=12345 type=message content=text from_id=6872058088 chat_id=6872058088 chat_type=private message_id=77 authorized=yes",
    );
    expect(line).not.toContain("secret user text");
  });

  it("records the safe Telegram media kind without file ids or captions", () => {
    const line = formatTelegramIngressAuditLine(
      {
        update: { update_id: 12346 },
        from: { id: 6872058088 },
        chat: { id: 6872058088, type: "private" },
        message: { message_id: 78, photo: [{ file_id: "secret-file-id" }], caption: "secret caption" },
      } as never,
      true,
    );

    expect(line).toContain("type=message content=photo");
    expect(line).not.toContain("secret-file-id");
    expect(line).not.toContain("secret caption");
  });
});
