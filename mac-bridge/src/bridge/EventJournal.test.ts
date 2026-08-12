import { describe, expect, it } from "vitest";

import { EventJournal, RequestDeduplicator } from "./EventJournal.js";

describe("EventJournal", () => {
  it("replays only unseen bounded events", () => {
    const journal = new EventJournal(2);
    journal.create({ type: "task_event", threadId: "a", turnId: null, phase: "working", message: "one", final: false });
    const second = journal.create({ type: "task_event", threadId: "a", turnId: null, phase: "progress", message: "two", final: false });
    journal.create({ type: "task_event", threadId: "a", turnId: null, phase: "completed", message: "three", final: true });

    expect(journal.after(second.eventId).map((event) => event.type)).toEqual(["task_event"]);
    expect(journal.after(0)).toHaveLength(2);
  });
});

describe("RequestDeduplicator", () => {
  it("rejects the second occurrence", () => {
    const dedupe = new RequestDeduplicator();
    expect(dedupe.isDuplicate("request-1")).toBe(false);
    expect(dedupe.isDuplicate("request-1")).toBe(true);
  });
});

