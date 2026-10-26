import { afterEach, describe, expect, it, vi } from "vitest";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { RefreshTokenService } from "./refresh_token.service.ts";

function fixture() {
  let record: any = null;
  const repository = {
    findOne: vi.fn(async () => record),
    create: vi.fn((value) => ({ ...value })),
    save: vi.fn(async (value) => { record = value; return value; }),
  };
  const users = { findUserWithID: vi.fn(async () => ({
    id: 7, username: "tester", role: "USER", first_name: "Test", last_name: "User",
  })) };
  const jwt = new JwtService({ secret: "unit-test-access-secret" });
  const service = new RefreshTokenService(repository as never, jwt, users as never);
  return { service, repository, users, jwt, record: () => record };
}

const identity = { id: 7, username: "tester", role: "USER" };
afterEach(() => vi.unstubAllEnvs());

describe("Refresh token lifecycle", () => {
  it("logs out using a raw JWT against a stored hash and rejects later refresh", async () => {
    vi.stubEnv("REFRESH_SECRET", "unit-test-refresh-secret");
    const f = fixture();
    const token = await f.service.createRefreshToken(identity as never);
    expect(f.record().hash_token).not.toBe(token);
    await expect(f.service.revokeRefreshToken(token)).resolves.toEqual({
      message: "Refresh token revoked successfully",
    });
    await expect(f.service.refreshToken(token)).rejects.toMatchObject({ status: 401 });
    expect(f.users.findUserWithID).not.toHaveBeenCalled();
  });

  it("persists a unique rotation and rejects replay despite identical JWT prefixes", async () => {
    vi.stubEnv("REFRESH_SECRET", "unit-test-refresh-secret");
    const f = fixture();
    const oldToken = await f.service.createRefreshToken(identity as never);
    const rotated = await f.service.refreshToken(oldToken);
    expect(rotated.refresh_token).not.toBe(oldToken);
    expect(rotated.refresh_token.slice(0, 72)).toBe(oldToken.slice(0, 72));
    await expect(f.service.validateRefreshToken(oldToken)).rejects.toMatchObject({ status: 401 });
    await expect(f.service.validateRefreshToken(rotated.refresh_token)).resolves.toBe(f.record());
  });

  it("rejects validly signed but unregistered tokens and malformed JWTs", async () => {
    vi.stubEnv("REFRESH_SECRET", "unit-test-refresh-secret");
    const f = fixture();
    const token = f.jwt.sign({ sub: 7 }, { secret: process.env.REFRESH_SECRET });
    await expect(f.service.refreshToken(token)).rejects.toMatchObject({ status: 401 });
    await expect(f.service.validateRefreshToken("invalid")).rejects.toMatchObject({ status: 401 });
    await expect(f.service.validateRefreshToken(undefined as never)).rejects.toMatchObject({ status: 401 });
    expect(f.users.findUserWithID).not.toHaveBeenCalled();
  });

  it("rejects expired persisted sessions and invalid subjects", async () => {
    vi.stubEnv("REFRESH_SECRET", "unit-test-refresh-secret");
    const f = fixture();
    const token = await f.service.createRefreshToken(identity as never);
    f.record().expires_at = new Date(0);
    await expect(f.service.validateRefreshToken(token)).rejects.toMatchObject({ status: 401 });
    const invalidSubject = f.jwt.sign({ sub: "7" }, { secret: process.env.REFRESH_SECRET });
    await expect(f.service.validateRefreshToken(invalidSubject)).rejects.toMatchObject({ status: 401 });
  });

  it("fails closed for legacy bcrypt hashes truncated at 72 bytes", async () => {
    vi.stubEnv("REFRESH_SECRET", "unit-test-refresh-secret");
    const f = fixture();
    const token = await f.service.createRefreshToken(identity as never);
    f.record().hash_token = await bcrypt.hash(token, 4);
    await expect(f.service.validateRefreshToken(token)).rejects.toMatchObject({ status: 401 });
  });
});
