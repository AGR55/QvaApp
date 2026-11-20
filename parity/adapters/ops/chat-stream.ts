/**
 * Operaciones de conformidad para `src/chat-stream.ts` y el caso de
 * concurrencia del chat de operación (`QvaPayClient.listChat`).
 *
 * - `chat.consume`     → cuenta cambios y valida el límite de memoria del SSE.
 * - `chat.order-read`  → demuestra que leer el chat de una orden no bloquea
 *                        una aplicación (`POST /p2p/:uuid/apply`).
 *
 * El flujo SSE se construye desde fragmentos de texto inyectados; no hay red
 * ni temporizadores reales. El cliente QvaPay usa un `fetch` falso con una
 * promesa liberada por el propio escenario.
 */
import { consumeChatStream } from "../../../src/chat-stream.js";
import { QvaPayClient } from "../../../src/qvapay.js";

type Input = Record<string, unknown>;

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

export const ops = {
  "chat.consume": async (input: Input) => {
    const chunks = input.chunks;
    if (!Array.isArray(chunks) || !chunks.every((chunk) => typeof chunk === "string")) {
      throw new Error("El campo chunks debe ser un array de textos.");
    }
    let changes = 0;
    await consumeChatStream(streamOf(chunks as string[]), () => {
      changes += 1;
    });
    return { changes };
  },

  "chat.order-read": async () => {
    let finishChat!: () => void;
    let chatStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      chatStarted = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      finishChat = resolve;
    });
    const paths: string[] = [];
    const qva = new QvaPayClient(() => "token", {
      fetch: async (input: RequestInfo | URL) => {
        const path = String(input);
        paths.push(path);
        if (path.includes("/chat")) {
          chatStarted();
          await waiting;
          return new Response(JSON.stringify({ chat: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ message: "ok" }), {
          headers: { "content-type": "application/json" },
        });
      },
      sleep: async () => undefined,
    });
    const read = qva.listChat("parent", "child");
    await started;
    await qva.apply("other");
    finishChat();
    await read;
    return { paths };
  },
};
