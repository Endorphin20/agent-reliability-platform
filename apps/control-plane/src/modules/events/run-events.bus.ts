import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface StoredTraceEvent {
  runId: string;
  runSequence: number;
  type: string;
  payload: unknown;
  attemptId: string | null;
  attemptSequence: number;
  occurredAt: string;
}

/** 进程内事件总线：TraceEventIngestor 落库后广播，SSE 订阅按 runId 分发 */
@Injectable()
export class RunEventsBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(1000);
  }

  publish(event: StoredTraceEvent): void {
    this.emitter.emit(`run:${event.runId}`, event);
  }

  subscribe(runId: string, listener: (event: StoredTraceEvent) => void): () => void {
    const channel = `run:${runId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}
