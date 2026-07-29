import { describe, expect, it } from "vitest";

import { isNearScrollEnd } from "./scroll";

describe("stream follow behaviour", () => {
  it("continues following while the reader is near the latest output", () => {
    expect(isNearScrollEnd({ scrollHeight: 1_000, scrollTop: 300, clientHeight: 600 })).toBe(true);
  });

  it("stops following when the reader scrolls up", () => {
    expect(isNearScrollEnd({ scrollHeight: 1_000, scrollTop: 100, clientHeight: 600 })).toBe(false);
  });

  it("supports a stricter threshold", () => {
    expect(isNearScrollEnd({ scrollHeight: 1_000, scrollTop: 370, clientHeight: 600 }, 20)).toBe(false);
  });
});
