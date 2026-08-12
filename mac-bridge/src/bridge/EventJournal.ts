import type { ServerControlMessage } from "@codex-commander/protocol";
import { PROTOCOL_VERSION } from "@codex-commander/protocol";

type EventPayload = ServerControlMessage extends infer Message
  ? Message extends ServerControlMessage
    ? Omit<Message, "protocol" | "eventId" | "sentAt">
    : never
  : never;

export class EventJournal {
  private nextEventId = 1;
  private readonly events: ServerControlMessage[] = [];

  constructor(private readonly capacity = 300) {}

  create(payload: EventPayload, remember = true): ServerControlMessage {
    const event = {
      ...payload,
      protocol: PROTOCOL_VERSION,
      eventId: this.nextEventId++,
      sentAt: Date.now()
    } as ServerControlMessage;
    if (remember) {
      this.events.push(event);
      if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    }
    return event;
  }

  after(lastEventId: number): ServerControlMessage[] {
    return this.events.filter((event) => event.eventId > lastEventId);
  }

  latestId(): number {
    return this.nextEventId - 1;
  }
}

export class RequestDeduplicator {
  private readonly seen = new Map<string, number>();

  constructor(private readonly capacity = 1_000) {}

  isDuplicate(requestId: string): boolean {
    if (this.seen.has(requestId)) return true;
    this.seen.set(requestId, Date.now());
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest) this.seen.delete(oldest);
    }
    return false;
  }
}
