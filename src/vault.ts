import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class Vault {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(hexKey))
      throw new Error(
        "LOCAL_ENCRYPTION_KEY debe contener 64 caracteres hexadecimales",
      );
    this.key = Buffer.from(hexKey, "hex");
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      data.toString("base64"),
    ].join(".");
  }

  decrypt(value: string): string {
    const [ivText, tagText, dataText] = value.split(".");
    if (!ivText || !tagText || !dataText)
      throw new Error("Token cifrado inválido");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(ivText, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataText, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}
