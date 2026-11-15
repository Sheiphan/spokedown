import { describe, expect, it } from "vitest";
import { buildSpeechScript } from "@spokedown/core";
import { shiftOffset, shiftScript } from "../src/shift.js";

describe("shiftOffset", () => {
  const ins = { rangeOffset: 10, rangeLength: 0, text: "abc" };
  const del = { rangeOffset: 10, rangeLength: 5, text: "" };
  it("leaves offsets before the change alone", () => expect(shiftOffset(5, [ins])).toBe(5));
  it("moves offsets after an insert", () => expect(shiftOffset(12, [ins])).toBe(15));
  it("moves offsets after a delete", () => expect(shiftOffset(20, [del])).toBe(15));
  it("clamps offsets inside a deleted range", () => expect(shiftOffset(12, [del])).toBe(10));
  it("handles several changes", () =>
    expect(shiftOffset(50, [{ rangeOffset: 0, rangeLength: 0, text: "xx" }, { rangeOffset: 30, rangeLength: 10, text: "y" }])).toBe(50 + 2 - 9));
});

describe("shiftScript", () => {
  it("keeps words pointing at the same text after an edit above them", async () => {
    const src = "# Title\n\nHello brave world.\n";
    const script = await buildSpeechScript(src);
    const edit = { rangeOffset: 0, rangeLength: 0, text: "Intro line.\n\n" };
    const next = edit.text + src;
    shiftScript(script, [edit]);
    const seg = script.segments.find((s) => s.text.startsWith("Hello"))!;
    expect(seg.words.map((w) => next.slice(w.srcStart, w.srcEnd))).toEqual(["Hello", "brave", "world."]);
    expect(next.slice(...seg.srcRange)).toBe("Hello brave world.");
  });
});
