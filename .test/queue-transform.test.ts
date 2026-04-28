import { describe, it, expect } from "vitest";
import { transformPendingQueue } from "../src/utils/process-queue-transform";
import type { PendingRequest } from "../src/types";

describe("transformPendingQueue", () => {
  const createMockRequest = (id: string, sid: number): PendingRequest => ({
    requestId: id,
    text: "test",
    speed: 1.0,
    volume: 1.0,
    speakerId: sid,
    resolve: () => {},
    reject: () => {},
  });

  it("should apply manual updates to speed and volume", () => {
    const queue = [createMockRequest("1", 0), createMockRequest("2", 1)];
    transformPendingQueue(queue, { speed: 2.0, volume: 0.5 }, { numSpeakers: 10 });

    expect(queue[0].speed).toBe(2.0);
    expect(queue[0].volume).toBe(0.5);
    expect(queue[1].speed).toBe(2.0);
    expect(queue[1].volume).toBe(0.5);
  });

  it("should validate and apply speakerId", () => {
    const queue = [createMockRequest("1", 0)];
    transformPendingQueue(queue, { speakerId: 5 }, { numSpeakers: 10 });
    expect(queue[0].speakerId).toBe(5);
  });

  it("should clamp out-of-bounds speakerId to 0", () => {
    const queue = [createMockRequest("1", 5)];
    // Transitioning to a model with only 2 speakers
    transformPendingQueue(queue, {}, { numSpeakers: 2 });
    expect(queue[0].speakerId).toBe(0);
  });

  it("should clamp invalid manual speakerId to 0", () => {
    const queue = [createMockRequest("1", 0)];
    transformPendingQueue(queue, { speakerId: 99 }, { numSpeakers: 10 });
    expect(queue[0].speakerId).toBe(0);
  });

  it("should preserve valid speakerId during transition", () => {
    const queue = [createMockRequest("1", 2)];
    transformPendingQueue(queue, {}, { numSpeakers: 10 });
    expect(queue[0].speakerId).toBe(2);
  });
});
