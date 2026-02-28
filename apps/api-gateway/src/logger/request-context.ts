import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContext = {
    traceId: string;
    userId?: string;
    role?: string;
    path?: string;
    method?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getCtx(): RequestContext | undefined {
    return requestContext.getStore();
}