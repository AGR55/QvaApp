import React, { useEffect, useState } from "react";
import { MessageSquareText, RefreshCcw, Send } from "lucide-react";
import { Empty, Skeleton } from "../components/common.jsx";
import { Button, Textarea } from "../components/ui.jsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx";
import { requestJson } from "../lib/http.js";
import { money } from "../lib/format.js";

const chatPath = (uuid) => `/api/operations/${encodeURIComponent(uuid)}/chat`;

export function OperationChatSheet({ operation, label, onUnreadChange, onClose }) {
  const [chat, setChat] = useState();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const uuid = operation?.uuid;

  useEffect(() => {
    if (!uuid) return undefined;
    let active = true;
    setChat(undefined);
    setDraft("");
    setError("");
    setStatus("");
    const load = async (fresh = false) => {
      if (!active) return;
      if (fresh) setLoading(true);
      try {
        const result = await requestJson(`${chatPath(uuid)}${fresh ? "?fresh=1" : ""}`, { timeoutMs: fresh ? 25_000 : 10_000 });
        if (!active) return;
        setChat(result.data);
        setError("");
        if (result.data.unreadCount) {
          const read = await requestJson(`${chatPath(uuid)}/read`, {
            method: "POST", headers: { "content-type": "application/json" }, body: "{}",
          });
          if (active) { setChat(read.data); onUnreadChange?.(); }
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "No se pudo actualizar el chat.");
      } finally { if (active && fresh) setLoading(false); }
    };
    void load(false).then(() => { if (active) return load(true); return undefined; });
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load(false);
    }, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [uuid, onUnreadChange]);

  const refresh = async () => {
    if (!uuid) return;
    setLoading(true);
    try {
      const result = await requestJson(`${chatPath(uuid)}?fresh=1`, { timeoutMs: 25_000 });
      setChat(result.data);
      setError("");
      if (result.data.unreadCount) {
        const read = await requestJson(`${chatPath(uuid)}/read`, {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
        setChat(read.data);
        onUnreadChange?.();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo actualizar el chat."); }
    finally { setLoading(false); }
  };

  const send = async (event) => {
    event.preventDefault();
    if (!uuid || !draft.trim() || sending) return;
    setSending(true); setError(""); setStatus("");
    try {
      const result = await requestJson(chatPath(uuid), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: draft.trim() }),
        timeoutMs: 20_000,
      });
      setChat(result.data.chat);
      setDraft("");
      setStatus("Mensaje enviado.");
      onUnreadChange?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo confirmar el envío.");
    } finally { setSending(false); }
  };

  return (
    <Sheet open={Boolean(operation)} onOpenChange={(open) => !open && onClose?.()}>
      <SheetContent className="operation-chat-sheet" aria-describedby="operation-chat-description">
        <SheetHeader className="operation-chat-header">
          <p className="operation-chat-kicker">OPERACIÓN · CONVERSACIÓN</p>
          <SheetTitle>Chat con la contraparte</SheetTitle>
          <p id="operation-chat-description" className="operation-chat-context">
            {operation ? `${money(operation.amount)} QUSD · ${label(operation.coin)}` : ""}
          </p>
        </SheetHeader>
        <div className="operation-chat-toolbar">
          <span className={chat?.stale ? "operation-chat-sync stale" : "operation-chat-sync"}>
            {chat?.updatedAt ? `${chat.stale ? "Copia guardada" : "Actualizado"} · ${new Date(chat.updatedAt).toLocaleTimeString("es-CU")}` : "Sin copia guardada"}
          </span>
          <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={refresh}>
            <RefreshCcw aria-hidden="true" data-icon="inline-start" className={loading ? "animate-spin" : ""} /> Actualizar
          </Button>
        </div>
        <div className="operation-chat-history" role="log" aria-label="Mensajes de la operación" aria-live="polite">
          {!chat && !error ? <Skeleton rows={4} label="Cargando conversación" /> : null}
          {chat && !chat.messages.length ? <Empty title="Aún no hay mensajes" icon={MessageSquareText}>La conversación aparecerá aquí cuando alguien escriba.</Empty> : null}
          {chat?.messages.length ? (
            <ol className="operation-chat-messages">
              {chat.messages.map((message) => (
                <li key={message.id} className={`operation-chat-message ${message.sender}`}>
                  <span className="operation-chat-message-author">{message.sender === "own" ? "Tú" : message.sender === "moderator" ? "Moderación" : "Contraparte"}</span>
                  <p>{message.message}</p>
                  {message.createdAt ? <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString("es-CU")}</time> : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
        <form className="operation-chat-composer" onSubmit={send}>
          <label htmlFor="operation-chat-draft">Mensaje</label>
          <Textarea id="operation-chat-draft" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={599} rows={3} placeholder="Escribe a la contraparte…" />
          <div className="operation-chat-compose-footer">
            <span>{draft.length}/599</span>
            <Button type="submit" variant="primary" disabled={sending || !draft.trim()}>
              <Send aria-hidden="true" data-icon="inline-start" /> {sending ? "Enviando…" : "Enviar"}
            </Button>
          </div>
          {error ? <p className="operation-chat-feedback error" role="alert">{error}</p> : null}
          {status ? <p className="operation-chat-feedback" role="status">{status}</p> : null}
        </form>
      </SheetContent>
    </Sheet>
  );
}
