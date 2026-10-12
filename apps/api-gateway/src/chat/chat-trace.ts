import { AsyncLocalStorage } from "node:async_hooks";
export const chatTrace = new AsyncLocalStorage<{ requestId: string }>();
export function requestId(): string { return chatTrace.getStore()?.requestId ?? "internal"; }
