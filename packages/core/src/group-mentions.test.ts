import { describe, expect, it } from "vitest";
import {
  hasMentionToken,
  inferHandoffTargetBotId,
  inferHandoffTargetName,
  isUnaddressedGroupMessage,
  mentionedMemberIds,
  resolveGroupTargetBotIds,
} from "./group-mentions.js";

const members = [
  { id: "a", name: "BotA" },
  { id: "b", name: "BotB" },
  { id: "c", name: "Writer" },
];

describe("hasMentionToken", () => {
  it("requires a boundary after the complete member name", () => {
    expect(hasMentionToken("Ask @Ann to review", "Ann")).toBe(true);
    expect(hasMentionToken("Ask @Ann, then continue", "Ann")).toBe(true);
    expect(hasMentionToken("Ask @Anna to review", "Ann")).toBe(false);
    expect(hasMentionToken("name@Ann", "Ann")).toBe(false);
    expect(hasMentionToken("contact@everyone", "everyone")).toBe(false);
  });

  it("supports multi-word and Unicode member names", () => {
    expect(hasMentionToken("Ask @Research Writer and @Éditeur", "Research Writer")).toBe(true);
    expect(hasMentionToken("Ask @Research Writer and @Éditeur", "Éditeur")).toBe(true);
  });
});

describe("resolveGroupTargetBotIds", () => {
  it("returns mentioned bots from text", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@BotA gather sources. @BotB summarize.",
        members,
      }),
    ).toEqual(["a", "b"]);
  });

  it("returns all members for @everyone", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@everyone please review",
        members,
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("merges explicit mentions", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello",
        members,
        explicitMentions: ["b"],
      }),
    ).toEqual(["b"]);
  });

  it("matches multi-word and Unicode names without prefix collisions", () => {
    const namedMembers = [
      { id: "research", name: "Research Writer" },
      { id: "edit", name: "Éditeur" },
      { id: "ann", name: "Ann" },
      { id: "anna", name: "Anna" },
    ];
    expect(
      resolveGroupTargetBotIds({
        text: "@Research Writer compare this with @Éditeur and @Anna.",
        members: namedMembers,
      }),
    ).toEqual(["research", "edit", "anna"]);
  });

  it("ignores explicit mentions for bots that are not group members", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello",
        members,
        explicitMentions: ["b", "outsider"],
      }),
    ).toEqual(["b"]);
  });

  it("picks the first member when unmentioned", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello team",
        members,
      }),
    ).toEqual(["a"]);
  });
});

describe("isUnaddressedGroupMessage", () => {
  it("is true only when no member is named by text or chip and nobody says @everyone", () => {
    expect(isUnaddressedGroupMessage({ text: "hello team", members })).toBe(true);
    expect(isUnaddressedGroupMessage({ text: "@BotB what do you think?", members })).toBe(false);
    expect(isUnaddressedGroupMessage({ text: "@everyone thoughts?", members })).toBe(false);
    expect(
      isUnaddressedGroupMessage({ text: "hello team", members, explicitMentions: ["c"] }),
    ).toBe(false);
  });

  it("ignores chips and prefixes that do not name a member", () => {
    expect(
      isUnaddressedGroupMessage({ text: "hello team", members, explicitMentions: ["outsider"] }),
    ).toBe(true);
    expect(isUnaddressedGroupMessage({ text: "ask @BotAB or mail ops@BotA", members })).toBe(true);
  });
});

describe("mentionedMemberIds", () => {
  it("returns the members a bot mentions in member order, never itself", () => {
    expect(mentionedMemberIds("@Writer polish it, then @BotA and I review", members, "b")).toEqual([
      "a",
      "c",
    ]);
    expect(mentionedMemberIds("I, @BotB, will take it", members, "b")).toEqual([]);
  });

  it("ignores @everyone from a bot", () => {
    expect(mentionedMemberIds("@everyone thoughts?", members, "a")).toEqual([]);
  });
});

describe("inferHandoffTargetName", () => {
  it("picks Writer when BotA is also mentioned", () => {
    expect(inferHandoffTargetName("@BotA hand this to Writer for the draft")).toBe("Writer");
  });
});

describe("inferHandoffTargetBotId", () => {
  it("recognizes hand this to Writer", () => {
    expect(inferHandoffTargetBotId("hand this to Writer for the draft", members)).toBe("c");
  });

  it("recognizes @Writer take the draft", () => {
    expect(inferHandoffTargetBotId("@Writer take the draft", members)).toBe("c");
  });

  it("resolves Writer from mixed mention prompt", () => {
    expect(inferHandoffTargetBotId("@BotA hand this to Writer for the draft", members)).toBe("c");
  });

  it("resolves multi-word handoff targets", () => {
    expect(
      inferHandoffTargetBotId("hand this to Research Writer for the draft", [
        ...members,
        { id: "research", name: "Research Writer" },
      ]),
    ).toBe("research");
  });
});
