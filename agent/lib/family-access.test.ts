/**
 * Family access policy tests.
 *
 * Constructs covered:
 * - `resolveConversationAccess`: derives trusted memory and tool scopes.
 * - Family group membership boundary.
 * - External group isolation boundary.
 */
import { describe, expect, it } from "vitest";

import { resolveConversationAccess } from "./family-access.js";

describe("resolveConversationAccess", () => {
  it("allows a family member to use personal and family memory in a private chat", () => {
    const access = resolveConversationAccess({
      actorKind: "telegram_user",
      chat: { id: "101", type: "private" },
      identity: { familyId: "family-1", role: "member", userId: "user-1" },
      registeredGroup: null,
    });

    expect(access).toEqual({
      familyId: "family-1",
      groupId: null,
      memoryScopes: ["personal", "family"],
      role: "member",
      userId: "user-1",
    });
  });

  it("allows only family memory in a family group", () => {
    const access = resolveConversationAccess({
      actorKind: "telegram_user",
      chat: { id: "-1001", type: "supergroup" },
      identity: { familyId: "family-1", role: "member", userId: "user-1" },
      registeredGroup: {
        familyId: "family-1",
        groupId: "group-1",
        messageMode: "addressed_only",
        skillAllowlist: [],
        telegramChatId: "-1001",
        toolAllowlist: [],
        type: "family_private",
      },
    });

    expect(access.memoryScopes).toEqual(["family"]);
    expect(access.groupId).toBe("group-1");
  });

  it("rejects a non-family caller in a family group", () => {
    expect(() =>
      resolveConversationAccess({
        actorKind: "telegram_user",
        chat: { id: "-1001", type: "group" },
        identity: null,
        registeredGroup: {
          familyId: "family-1",
          groupId: "group-1",
          messageMode: "addressed_only",
          skillAllowlist: [],
          telegramChatId: "-1001",
          toolAllowlist: [],
          type: "family_private",
        },
      }),
    ).toThrowError(/AGENT_ACCESS_DENIED/);
  });

  it("isolates an external group from personal and family memory", () => {
    const access = resolveConversationAccess({
      actorKind: "telegram_user",
      chat: { id: "-2001", type: "group" },
      identity: null,
      registeredGroup: {
        familyId: "family-1",
        groupId: "group-2",
        messageMode: "all",
        skillAllowlist: [],
        telegramChatId: "-2001",
        toolAllowlist: ["remember"],
        type: "external",
      },
    });

    expect(access).toEqual({
      familyId: "family-1",
      groupId: "group-2",
      memoryScopes: ["group"],
      role: "external",
      userId: null,
    });
  });

  it("admits a bot participant to an external group without any account", () => {
    const access = resolveConversationAccess({
      actorKind: "telegram_bot",
      chat: { id: "-2001", type: "group" },
      identity: null,
      registeredGroup: {
        familyId: "family-1",
        groupId: "group-2",
        messageMode: "all",
        skillAllowlist: [],
        telegramChatId: "-2001",
        toolAllowlist: [],
        type: "external",
      },
    });

    expect(access).toEqual({
      familyId: "family-1",
      groupId: "group-2",
      memoryScopes: ["group"],
      role: "external",
      userId: null,
    });
  });

  it("keeps a bot out of an owner-only external group", () => {
    expect(() =>
      resolveConversationAccess({
        actorKind: "telegram_bot",
        chat: { id: "-2001", type: "group" },
        identity: null,
        registeredGroup: {
          familyId: "family-1",
          groupId: "group-2",
          messageMode: "owner_only",
          skillAllowlist: [],
          telegramChatId: "-2001",
          toolAllowlist: [],
          type: "external",
        },
      }),
    ).toThrowError(/AGENT_TELEGRAM_BOT_NOT_ADMITTED/);
  });

  it("keeps a bot out of the trusted family zone", () => {
    expect(() =>
      resolveConversationAccess({
        actorKind: "telegram_bot",
        chat: { id: "-1001", type: "group" },
        identity: null,
        registeredGroup: {
          familyId: "family-1",
          groupId: "group-1",
          messageMode: "all",
          skillAllowlist: [],
          telegramChatId: "-1001",
          toolAllowlist: [],
          type: "family_private",
        },
      }),
    ).toThrowError(/AGENT_ACCESS_DENIED/);
  });

  it("keeps a bot out of private chats", () => {
    expect(() =>
      resolveConversationAccess({
        actorKind: "telegram_bot",
        chat: { id: "42", type: "private" },
        identity: null,
        registeredGroup: null,
      }),
    ).toThrowError(/AGENT_ACCESS_DENIED/);
  });

  it("rejects an unregistered group before model execution", () => {
    expect(() =>
      resolveConversationAccess({
        actorKind: "telegram_user",
        chat: { id: "-3001", type: "group" },
        identity: null,
        registeredGroup: null,
      }),
    ).toThrowError(/AGENT_GROUP_NOT_REGISTERED/);
  });
});
