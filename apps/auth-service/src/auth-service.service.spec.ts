import { describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth-service.service.ts";

describe("Sign-in credential validation", () => {
  it.each([
    undefined, null, {}, { username: "", password: "password" },
    { username: "   ", password: "password" },
    { username: "user" }, { username: "user", password: "" },
    { username: ["user"], password: "password" },
    { username: "user", password: 123 },
  ])("rejects malformed credentials before any database lookup: %j", async (input) => {
    const users = { findUserWithUsername: vi.fn() };
    const service = new AuthService(users as never, {} as never, {} as never,
      { setServiceName: vi.fn() } as never, {} as never);

    await expect(service.signIn(input as never)).rejects.toMatchObject({ status: 401 });
    expect(users.findUserWithUsername).not.toHaveBeenCalled();
  });

  it("preserves the invalid-credentials response for an unknown username", async () => {
    const users = { findUserWithUsername: vi.fn().mockResolvedValue(null) };
    const service = new AuthService(users as never, {} as never, {} as never,
      { setServiceName: vi.fn() } as never, {} as never);
    await expect(service.signIn({ username: "unknown", password: "password" }))
      .rejects.toMatchObject({ status: 401 });
    expect(users.findUserWithUsername).toHaveBeenCalledWith("unknown");
  });
});
