import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDays,
  isValidTimeZone,
  localDateString,
  localTimeString,
  parseIsoDate,
  startOfLocalDay,
  startOfLocalMonth,
  timeZoneOffsetMs,
  zonedDateTimeToInstant,
} from "../../packages/shared/src/dates.ts";

describe("calendar dates", () => {
  it("parses strict ISO dates", () => {
    assert.deepEqual(parseIsoDate("2026-02-28"), { year: 2026, month: 2, day: 28 });
    assert.equal(parseIsoDate("2026-02-29"), null);
    assert.equal(parseIsoDate("2028-02-29")?.day, 29);
    assert.equal(parseIsoDate("2026-13-01"), null);
    assert.equal(parseIsoDate("2026-1-01"), null);
  });

  it("adds days across month and year boundaries", () => {
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });
});

describe("time zones", () => {
  it("validates IANA names", () => {
    assert.ok(isValidTimeZone("Europe/Paris"));
    assert.ok(!isValidTimeZone("Mars/Olympus_Mons"));
    assert.ok(!isValidTimeZone(""));
  });

  it("computes local calendar dates", () => {
    const instant = new Date("2026-09-01T02:30:00Z");
    assert.equal(localDateString(instant, "America/New_York"), "2026-08-31");
    assert.equal(localDateString(instant, "Europe/Berlin"), "2026-09-01");
    assert.equal(localTimeString(instant, "Asia/Tokyo"), "11:30");
  });

  it("converts wall-clock times to instants", () => {
    assert.equal(zonedDateTimeToInstant("2026-03-10", "09:00", "Europe/Paris").toISOString(), "2026-03-10T08:00:00.000Z");
    assert.equal(zonedDateTimeToInstant("2026-07-10", "09:00", "Europe/Paris").toISOString(), "2026-07-10T07:00:00.000Z");
    assert.equal(zonedDateTimeToInstant("2026-10-07", "00:00", "Asia/Tokyo").toISOString(), "2026-10-06T15:00:00.000Z");
  });

  it("handles daylight saving transitions", () => {
    // US clocks fall back on 2026-11-01.
    assert.equal(zonedDateTimeToInstant("2026-10-31", "09:00", "America/New_York").toISOString(), "2026-10-31T13:00:00.000Z");
    assert.equal(zonedDateTimeToInstant("2026-11-02", "09:00", "America/New_York").toISOString(), "2026-11-02T14:00:00.000Z");
    // 02:30 does not exist on 2026-03-08 in New York; it is moved forward.
    assert.equal(zonedDateTimeToInstant("2026-03-08", "02:30", "America/New_York").toISOString(), "2026-03-08T07:30:00.000Z");
  });

  it("finds the start of the local day and month", () => {
    const instant = new Date("2026-10-01T03:45:00Z");
    assert.equal(startOfLocalDay(instant, "America/New_York").toISOString(), "2026-09-30T04:00:00.000Z");
    assert.equal(startOfLocalMonth(instant, "America/New_York").toISOString(), "2026-09-01T04:00:00.000Z");
    assert.equal(startOfLocalMonth(instant, "UTC").toISOString(), "2026-10-01T00:00:00.000Z");
  });

  it("reports offsets", () => {
    assert.equal(timeZoneOffsetMs(new Date("2026-01-15T12:00:00Z"), "Europe/Berlin"), 3_600_000);
    assert.equal(timeZoneOffsetMs(new Date("2026-07-15T12:00:00Z"), "America/New_York"), -4 * 3_600_000);
  });
});
