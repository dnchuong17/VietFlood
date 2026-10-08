import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";

import { ChatCryptoService } from "./chat-crypto.service";

describe("ChatCryptoService", () => {
  const firstKey = Buffer.alloc(32, 1).toString("base64");
  const secondKey = Buffer.alloc(32, 2).toString("base64");

  beforeEach(() => {
    vi.stubEnv("CHAT_KEYRING_B64", Buffer.from(JSON.stringify({ V1: firstKey, V2: secondKey })).toString("base64"));
    vi.stubEnv("CHAT_KEY_CURRENT", "V1");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("encrypts message content and binds it to the user, session, message and role", () => {
    const crypto = new ChatCryptoService();
    const encrypted = crypto.encrypt("private chat text", 7, "session-a", "message-a", "user");
    expect(encrypted.ciphertext.toString("utf8")).not.toContain("private chat text");
    expect(crypto.decrypt(encrypted, 7, "session-a", "message-a", "user")).toBe("private chat text");
    for (const [userId, sessionId, messageId, role] of [
      [8, "session-a", "message-a", "user"],
      [7, "session-b", "message-a", "user"],
      [7, "session-a", "message-b", "user"],
      [7, "session-a", "message-a", "assistant"],
    ] as const) {
      expect(() => crypto.decrypt(encrypted, userId, sessionId, messageId, role))
        .toThrow(ServiceUnavailableException);
    }
  });

  it("reads old ciphertext after switching the active key", () => {
    const first = new ChatCryptoService();
    const old = first.encrypt("saved message", 7, "session-a", "message-a", "user");
    vi.stubEnv("CHAT_KEY_CURRENT", "V2");
    const rotated = new ChatCryptoService();
    expect(rotated.decrypt(old, 7, "session-a", "message-a", "user")).toBe("saved message");
    expect(rotated.encrypt("new message", 7, "session-a", "message-b", "user").keyId).toBe("V2");
  });

  it("rejects missing or invalid encryption keys at startup", () => {
    vi.stubEnv("CHAT_KEY_CURRENT", "MISSING");
    expect(() => new ChatCryptoService()).toThrow("Active chat encryption key is unavailable");
    vi.stubEnv("CHAT_KEYRING_B64", Buffer.from(JSON.stringify({ V1: "short" })).toString("base64"));
    vi.stubEnv("CHAT_KEY_CURRENT", "V1");
    expect(() => new ChatCryptoService()).toThrow("Chat encryption keyring is invalid");
  });
});
