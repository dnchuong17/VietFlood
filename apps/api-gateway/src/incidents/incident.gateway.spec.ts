import { describe, it, expect, vi, afterEach } from "vitest";
import { JwtService } from "@nestjs/jwt";
import { IncidentEventsGateway } from "./incident.gateway";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("private incident socket authorization", () => {
  function harness(token: string, read = vi.fn().mockResolvedValue({})) {
    vi.stubEnv("JWT_SECRET", "incident-socket-test-secret");
    const socket = {
      handshake: { auth: { token } },
      connected: true,
      join: vi.fn(),
      disconnect: vi.fn(),
      once: vi.fn(),
    };
    const gateway = new IncidentEventsGateway(
      {} as never,
      new JwtService(),
      { read } as never,
      { warn: vi.fn() } as never,
    );
    return { socket, gateway, read };
  }
  const signed = (role: string) =>
    new JwtService({ secret: "incident-socket-test-secret" }).sign(
      { sub: 1, role },
      { expiresIn: "1h" },
    );
  it("rejects missing, forged, expired and citizen tokens before joining rooms", async () => {
    for (const token of [
      "",
      "forged",
      signed("citizen"),
      new JwtService({ secret: "incident-socket-test-secret" }).sign(
        { sub: 1, role: "admin" },
        { expiresIn: -1 },
      ),
    ]) {
      const { socket, gateway, read } = harness(token);
      await gateway.handleConnection(socket as never);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.join).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    }
  });
  it("checks the current server-side role and disconnects when the JWT expires", async () => {
    vi.useFakeTimers();
    const { socket, gateway, read } = harness(signed("relief"));
    await gateway.handleConnection(socket as never);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ user: { userId: 1, role: "relief" } }),
      "overview",
    );
    expect(socket.join).toHaveBeenCalledWith("operations");
    await vi.advanceTimersByTimeAsync(3600001);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
  it("rejects a token whose account no longer has an operational role", async () => {
    const { socket, gateway } = harness(
      signed("admin"),
      vi.fn().mockRejectedValue(new Error("role_changed")),
    );
    await gateway.handleConnection(socket as never);
    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});
