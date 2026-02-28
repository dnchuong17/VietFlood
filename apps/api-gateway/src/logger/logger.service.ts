import { Injectable } from '@nestjs/common';
import { getCtx } from './request-context';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

@Injectable()
export class LoggerService {
    private serviceName = 'api-gateway';

    setServiceName(name: string) {
        this.serviceName = name;
    }

    debug(message: string, meta?: Record<string, any>) {
        this.log('debug', message, meta);
    }

    info(message: string, meta?: Record<string, any>) {
        this.log('info', message, meta);
    }

    warn(message: string, meta?: Record<string, any>) {
        this.log('warn', message, meta);
    }

    error(message: string, meta?: Record<string, any>) {
        this.log('error', message, meta);
    }

    private log(level: LogLevel, message: string, meta?: Record<string, any>) {
        const ctx = getCtx();
        const payload = {
            ts: new Date().toISOString(),
            level,
            service: this.serviceName,
            traceId: ctx?.traceId,
            userId: ctx?.userId,
            role: ctx?.role,
            path: ctx?.path,
            method: ctx?.method,
            message,
            ...meta,
        };

        console[level === 'debug' ? 'log' : level](JSON.stringify(payload));
    }
}