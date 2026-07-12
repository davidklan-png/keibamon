import { describe, it, expect } from "vitest";
import { buildInviteUrl } from "./inviteUrl";

describe("buildInviteUrl", () => {
  it("lands on the app base (/app/), not the splash root", () => {
    expect(buildInviteUrl("alyssa", "/app/", "https://keibamon.com")).toBe(
      "https://keibamon.com/app/?friend=alyssa",
    );
  });

  it("uses the provided base path (import.meta.env.BASE_URL at runtime)", () => {
    // A non-default base must be honored, not hardcoded.
    expect(buildInviteUrl("bo", "/app/", "https://keibamon.com")).toBe(
      "https://keibamon.com/app/?friend=bo",
    );
    expect(buildInviteUrl("bo", "/", "https://keibamon.com")).toBe(
      "https://keibamon.com/?friend=bo",
    );
  });

  it("URI-encodes the handle", () => {
    expect(buildInviteUrl("a b/c", "/app/", "https://x")).toBe(
      "https://x/app/?friend=a%20b%2Fc",
    );
  });

  it("preserves handles that need no encoding (letters / digits / underscore)", () => {
    expect(buildInviteUrl("alyssa_99", "/app/", "https://x")).toBe(
      "https://x/app/?friend=alyssa_99",
    );
  });
});
