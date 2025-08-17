import crypto from "node:crypto";
import { serverOnly } from "@tanstack/react-start";
import { env } from "~/env/server";

const getKey = serverOnly(() => {
  const keyHex = env.MASTER_KEY;
  // Expect hex string of 32 bytes (64 chars)
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("MASTER_KEY must be 32-byte hex (64 chars)");
  }
  return key;
});

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack as base64: iv|tag|cipher
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decrypt(blob: string): string {
  const key = getKey();
  const buff = Buffer.from(blob, "base64");
  const iv = buff.subarray(0, 12);
  const tag = buff.subarray(12, 28);
  const data = buff.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  return plaintext;
}
