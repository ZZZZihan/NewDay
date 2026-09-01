import { describe, expect, it } from "vitest";

import { localDateSchema } from "./planner-model";

describe("localDateSchema", () => {
  it("accepts real calendar dates including leap days", () => {
    expect(localDateSchema.parse("2028-02-29")).toBe("2028-02-29");
  });

  it.each(["2026-02-29", "2026-02-31", "2026-13-01", "2026-00-10"])(
    "rejects the invalid calendar date %s",
    (date) => {
      expect(localDateSchema.safeParse(date).success).toBe(false);
    },
  );
});
