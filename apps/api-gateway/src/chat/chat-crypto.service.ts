import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";

export type ChatRole = "user" | "assistant";
export type EncryptedMessage = {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyId: string;
};

@Injectable()
export class ChatCryptoService {
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyId: string;

  constructor() {
    const encoded = process.env.CHAT_KEYRING_B64;
    const active = process.env.CHAT_KEY_CURRENT;
    if (!encoded || !active)
      throw new Error("Chat encryption keys are not configured");

    let keyring: unknown;
    try {
      keyring = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      throw new Error("Chat encryption keyring is invalid");
    }
    if (!keyring || typeof keyring !== "object" || Array.isArray(keyring))
      throw new Error("Chat encryption keyring is invalid");

    for (const [id, value] of Object.entries(keyring)) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || typeof value !== "string")
        throw new Error("Chat encryption keyring is invalid");
      const key = Buffer.from(value, "base64");
      if (key.length !== 32 || key.toString("base64") !== value)
        throw new Error("Chat encryption keyring is invalid");
      this.keys.set(id, key);
    }
    if (!this.keys.has(active))
      throw new Error("Active chat encryption key is unavailable");
    this.activeKeyId = active;
  }

  get activeKey(): string {
    return this.activeKeyId;
  }

  encrypt(
    content: string,
    userId: number,
    sessionId: string,
    messageId: string,
    role: ChatRole,
  ): EncryptedMessage {
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.keys.get(this.activeKeyId)!,
      nonce,
    );
    cipher.setAAD(this.aad(userId, sessionId, messageId, role));
    const ciphertext = Buffer.concat([
      cipher.update(content, "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext,
      nonce,
      authTag: cipher.getAuthTag(),
      keyId: this.activeKeyId,
    };
  }

  decrypt(
    encrypted: EncryptedMessage,
    userId: number,
    sessionId: string,
    messageId: string,
    role: ChatRole,
  ): string {
    const key = this.keys.get(encrypted.keyId);
    if (!key)
      throw new ServiceUnavailableException("Chat history is unavailable");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, encrypted.nonce);
      decipher.setAAD(this.aad(userId, sessionId, messageId, role));
      decipher.setAuthTag(encrypted.authTag);
      return Buffer.concat([
        decipher.update(encrypted.ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new ServiceUnavailableException("Chat history is unavailable");
    }
  }

  private aad(
    userId: number,
    sessionId: string,
    messageId: string,
    role: ChatRole,
  ): Buffer {
    return Buffer.from(
      JSON.stringify([userId, sessionId, messageId, role]),
      "utf8",
    );
  }
}
