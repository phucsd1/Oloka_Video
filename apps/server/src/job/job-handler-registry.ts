import type { ClaimedJob } from "./job-repository.js";

export interface JobHandler {
  readonly type: ClaimedJob["type"];
  handle(claim: ClaimedJob): Promise<void>;
}

export class JobHandlerRegistry {
  private readonly handlers = new Map<ClaimedJob["type"], JobHandler>();

  constructor(handlers: readonly JobHandler[]) {
    for (const handler of handlers) {
      if (this.handlers.has(handler.type))
        throw new Error(`Duplicate Job handler: ${handler.type}`);
      this.handlers.set(handler.type, handler);
    }
  }

  get(type: ClaimedJob["type"]): JobHandler | undefined {
    return this.handlers.get(type);
  }

  enabledTypes(): readonly ClaimedJob["type"][] {
    return [...this.handlers.keys()];
  }
}
