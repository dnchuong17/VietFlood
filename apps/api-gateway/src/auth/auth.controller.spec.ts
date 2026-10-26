import { describe, expect, it, vi } from "vitest";
import { AuthController } from "./auth.controller.ts";

describe("Logout request contract", () => {
  it.each([{ refresh: "signed-refresh-token" }, { refresh_token: "signed-refresh-token" }])(
    "extracts the raw token from the JSON body: %j", async (body) => {
      const auth = { logout: vi.fn().mockResolvedValue({ message: "revoked" }) };
      const controller = new AuthController(auth as never);
      await expect(controller.logout(body)).resolves.toEqual({ message: "revoked" });
      expect(auth.logout).toHaveBeenCalledWith("signed-refresh-token");
    },
  );

  it.each([undefined, {}, { refresh: "" }, { refresh: "   " }, { refresh: 7 }, { refresh: {} }])(
    "rejects missing or malformed tokens before sending an RMQ request: %j", async (body) => {
      const auth = { logout: vi.fn() };
      const controller = new AuthController(auth as never);
      await expect(controller.logout(body)).rejects.toMatchObject({ status: 400 });
      expect(auth.logout).not.toHaveBeenCalled();
    },
  );
});
