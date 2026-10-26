import { Injectable, UnauthorizedException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { RefreshTokenEntity } from "./refresh_token.entity";
import { Repository } from "typeorm";
import { JwtService } from "@nestjs/jwt";
import { RefreshTokenDto } from "../DTO/refresh_token.dto";
import * as bcrypt from "bcrypt";
import { createHash, randomUUID } from "node:crypto";
import { UsersService } from "../users/users.service";

interface RefreshPayload {
  sub: number;
}

// JWTs exceed bcrypt's 72-byte input limit. Hash the entire token first so
// rotation cannot accidentally accept an older token with the same prefix.
function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class RefreshTokenService {
  constructor(
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokenRepository: Repository<RefreshTokenEntity>,
    private readonly jwtService: JwtService,
    private readonly userService: UsersService,
  ) {}

  async createRefreshToken(refreshDto: RefreshTokenDto) {
    const payload = {
      sub: refreshDto.id,
      username: refreshDto.username,
      role: refreshDto.role,
      jti: randomUUID(),
    };
    const refreshToken = this.jwtService.sign(payload, {
      secret: process.env.REFRESH_SECRET,
      expiresIn: "7d",
    });
    const hashToken = await bcrypt.hash(tokenDigest(refreshToken), 10);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const existingRefreshToken = await this.refreshTokenRepository.findOne({
      where: { user: { id: refreshDto.id } },
    });
    const record =
      existingRefreshToken ??
      this.refreshTokenRepository.create({
        user: { id: refreshDto.id },
      });
    record.hash_token = hashToken;
    record.expires_at = expiresAt;
    record.revoked_at = null;
    await this.refreshTokenRepository.save(record);
    return refreshToken;
  }

  async refreshToken(refreshToken: string) {
    const existing = await this.validateRefreshToken(refreshToken);
    const user = await this.userService.findUserWithID(existing.user.id);
    if (!user) {
      throw new UnauthorizedException("User not found");
    }
    const accessToken = this.jwtService.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
      first_name: user.first_name,
      last_name: user.last_name,
    });
    const rotatedToken = await this.createRefreshToken({
      id: user.id,
      username: user.username,
      role: user.role,
    });
    return { access_token: accessToken, refresh_token: rotatedToken };
  }

  async validateRefreshToken(token: string) {
    if (typeof token !== "string" || !token) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    let payload: RefreshPayload;
    try {
      payload = this.jwtService.verify<RefreshPayload>(token, {
        secret: process.env.REFRESH_SECRET,
      });
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
    if (!Number.isSafeInteger(payload.sub) || payload.sub <= 0) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    const existing = await this.refreshTokenRepository.findOne({
      where: { user: { id: payload.sub } },
      relations: { user: true },
    });
    if (
      !existing ||
      !(await bcrypt.compare(tokenDigest(token), existing.hash_token))
    ) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    if (existing.revoked_at) {
      throw new UnauthorizedException("Refresh token has been revoked");
    }
    if (existing.expires_at <= new Date()) {
      throw new UnauthorizedException("Refresh token expired");
    }
    return existing;
  }

  async revokeRefreshToken(token: string) {
    const existing = await this.validateRefreshToken(token);
    existing.revoked_at = new Date();
    await this.refreshTokenRepository.save(existing);
    return { message: "Refresh token revoked successfully" };
  }
}
