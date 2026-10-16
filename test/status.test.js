import test from "node:test";
import assert from "node:assert/strict";
import { formatLocalExpiration } from "../src/status.js";

test("expiration uses local time, minute precision, and compact numeric UTC offsets", () => {
  const previous = process.env.TZ;
  try {
    for (const [zone, input, expected] of [
      ["Asia/Tokyo", "2026-10-15T10:40:59Z", "2026-10-15T19:40+9"],
      ["Asia/Kolkata", "2026-10-15T10:40:00Z", "2026-10-15T16:10+5:30"],
      ["America/St_Johns", "2026-01-15T02:40:00Z", "2026-01-14T23:10-3:30"],
      ["America/New_York", "2026-07-15T10:40:00Z", "2026-07-15T06:40-4"],
      ["America/New_York", "2026-01-15T10:40:00Z", "2026-01-15T05:40-5"],
      ["UTC", "2026-10-15T10:40:00Z", "2026-10-15T10:40+0"],
    ]) {
      process.env.TZ = zone;
      assert.equal(formatLocalExpiration(input), expected);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
