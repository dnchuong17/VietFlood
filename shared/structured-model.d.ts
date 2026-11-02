export type ChatActionIntent = {
  intent: string;
  arguments: Record<string, unknown>;
};
export declare class StructuredModelClient {
  constructor(logger: any, trace?: () => string);
  isConfigured(): boolean;
  onModuleInit(): void;
  structured<T>(
    instruction: string,
    data: unknown,
    schema: object,
    signal: AbortSignal,
  ): Promise<T>;
  understandAction(
    message: string,
    role: string,
    pending?: ChatActionIntent,
  ): Promise<ChatActionIntent | null>;
}
