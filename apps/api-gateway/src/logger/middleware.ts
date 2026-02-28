import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { requestContext } from './request-context';

@Injectable()
export class TraceMiddleware implements NestMiddleware {
    use(req: Request, res: Response, next: NextFunction) {
        const incoming = req.header('x-request-id');
        const traceId = incoming && incoming.length > 0 ? incoming : randomUUID();

        res.setHeader('x-request-id', traceId);

        requestContext.run(
            {
                traceId,
                path: req.originalUrl,
                method: req.method,
            },
            () => next(),
        );
    }
}