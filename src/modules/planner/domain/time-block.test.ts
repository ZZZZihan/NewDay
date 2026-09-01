import { describe, expect, it } from "vitest";

import { findOverlappingBlockIds } from "./time-block";

function block(id: string, start: string, end: string) {
  return {
    id,
    start: new Date(`2026-09-01T${start}:00+08:00`),
    end: new Date(`2026-09-01T${end}:00+08:00`),
  };
}

describe("findOverlappingBlockIds", () => {
  it("returns no conflicts for separated blocks", () => {
    const conflicts = findOverlappingBlockIds([
      block("write", "09:00", "10:00"),
      block("email", "10:30", "11:00"),
    ]);

    expect([...conflicts]).toEqual([]);
  });

  it("does not treat touching boundaries as an overlap", () => {
    const conflicts = findOverlappingBlockIds([
      block("write", "09:00", "10:00"),
      block("email", "10:00", "10:30"),
    ]);

    expect([...conflicts]).toEqual([]);
  });

  it("marks every block involved in an overlap", () => {
    const conflicts = findOverlappingBlockIds([
      block("write", "09:00", "10:30"),
      block("email", "10:00", "11:00"),
      block("meeting", "10:45", "11:30"),
      block("lunch", "12:00", "13:00"),
    ]);

    expect([...conflicts].sort()).toEqual(["email", "meeting", "write"]);
  });
});
