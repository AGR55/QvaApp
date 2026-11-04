import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface OperationTrace {
  traceId: string;
  operationUuid: string;
  action: string;
}

export interface OperationRequestTiming extends OperationTrace {
  requestId: string;
  policy: string;
  method: string;
  queueMs?: number;
  throttleMs?: number;
  upstreamMs?: number;
  totalMs: number;
  outcome: "success" | "failed";
}

interface TraceContext extends OperationTrace {
  observe: (timing: OperationRequestTiming) => void;
}

const operationTrace = new AsyncLocalStorage<TraceContext>();

export function withOperationTrace<Result>(trace: OperationTrace, observe: TraceContext["observe"], run: () => Promise<Result>): Promise<Result> {
  return operationTrace.run({ ...trace, observe }, run);
}

export function beginOperationRequest(policy: string, method: string) {
  const context = operationTrace.getStore();
  if (!context) return undefined;
  const started = performance.now();
  const requestId = randomUUID();
  let dequeued: number | undefined;
  let dispatched: number | undefined;
  let finished = false;
  return {
    dequeued() { dequeued = performance.now(); },
    dispatched() { dispatched = performance.now(); },
    finish(outcome: OperationRequestTiming["outcome"]) {
      if (finished) return;
      finished = true;
      const completed = performance.now();
      try {
        context.observe({
          traceId: context.traceId, operationUuid: context.operationUuid, action: context.action,
          requestId, policy, method, totalMs: completed - started, outcome,
          ...(dequeued === undefined ? {} : { queueMs: dequeued - started }),
          ...(dequeued === undefined || dispatched === undefined ? {} : { throttleMs: dispatched - dequeued }),
          ...(dispatched === undefined ? {} : { upstreamMs: completed - dispatched }),
        });
      } catch {}
    },
  };
}

export type OperationRequestTimer = ReturnType<typeof beginOperationRequest>;
