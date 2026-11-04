export const CHAT_IMAGE_MAX_BYTES = 1_048_576;
export const CHAT_MULTIPART_MAX_BYTES = CHAT_IMAGE_MAX_BYTES + 16_384;

export interface ChatImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
}

export function validateChatImage(bytes: Uint8Array, declaredType: string): ChatImage {
  if (!bytes.length || bytes.length > CHAT_IMAGE_MAX_BYTES) throw new Error("La imagen debe ocupar como máximo 1 MiB.");
  const data = Buffer.from(bytes);
  let width = 0;
  let height = 0;
  let mimeType: ChatImage["mimeType"];
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString("ascii",12,16) === "IHDR") {
    mimeType = "image/png";
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
  } else if (data.length >= 4 && data[0] === 255 && data[1] === 216 && data[data.length-2] === 255 && data[data.length-1] === 217) {
    mimeType = "image/jpeg";
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 218 || marker === 217) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if (marker !== undefined && [192,193,194].includes(marker) && length >= 8) {
        height = data.readUInt16BE(offset+3);
        width = data.readUInt16BE(offset+5);
        break;
      }
      offset += length;
    }
  } else throw new Error("Solo se admiten imágenes JPEG o PNG.");
  if (declaredType !== mimeType || width < 1 || height < 1 || width > 1000 || height > 1000)
    throw new Error("Imagen inválida: JPEG/PNG de hasta 1000×1000 píxeles.");
  return { bytes, mimeType };
}

export async function parseChatImageMultipart(body: Buffer, contentType: string) {
  const form = await new Request("https://local.invalid", {
    method: "POST", headers: { "content-type": contentType }, body: new Uint8Array(body),
  }).formData();
  if ([...form.keys()].some(key => !["file", "message", "attemptId"].includes(key)) ||
      ["file", "message", "attemptId"].some(key => form.getAll(key).length > 1)) throw new Error("Formulario de imagen inválido.");
  const file = form.get("file");
  const message = form.get("message") ?? "";
  const attemptId = form.get("attemptId");
  if (!(file instanceof File) || typeof message !== "string" || message.length > 599 ||
      typeof attemptId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(attemptId)) throw new Error("Imagen, texto o identificador de envío inválidos.");
  return { image: validateChatImage(new Uint8Array(await file.arrayBuffer()), file.type), message: message.trim(), attemptId };
}

export function chatImageUrl(reference: string): URL {
  const url = new URL(reference);
  if (url.protocol !== "https:" || !["www.qvapay.com", "api.qvapay.com"].includes(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash ||
      !/^\/storage\/[a-zA-Z0-9_/-]+\.(?:jpe?g|png)$/.test(url.pathname)) throw new Error("Referencia de imagen no compatible.");
  return url;
}
