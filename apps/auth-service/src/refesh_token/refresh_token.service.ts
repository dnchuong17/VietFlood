import { Injectable, UnauthorizedException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { RefreshTokenEntity } from "./refresh_token.entity";
import { Repository } from "typeorm";
import { JwtService } from "@nestjs/jwt";
import { RefreshTokenDto } from "../DTO/refresh_token.dto";
import * as bcrypt from "bcrypt";
import { UserEntity } from "../users/users.entity";
import { UsersService } from "../users/users.service";

@Injectable()
export class RefreshTokenService {
  constructor(
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokenRepository: Repository<RefreshTokenEntity>,
    @InjectRepository(RefreshTokenEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly jwtService: JwtService,
    private readonly userService: UsersService,
  ) {}

  async createRefreshToken(refreshDto: RefreshTokenDto) {
    const payload = {
      sub: refreshDto.id,
      username: refreshDto.username,
      role: refreshDto.role,
    };

    const refreshToken = this.jwtService.sign(payload, {
      secret: process.env.REFRESH_SECRET,
      expiresIn: "7d",
    });

    const hashToken = await bcrypt.hash(refreshToken, 10);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const existingRefreshToken = await this.refreshTokenRepository.findOne({
      where: {
        user: { id: refreshDto.id },
      },
    });

    if (existingRefreshToken) {
      existingRefreshToken.hash_token = hashToken;
      existingRefreshToken.expires_at = expiresAt;
      existingRefreshToken.revoked_at = null;

      await this.refreshTokenRepository.save(existingRefreshToken);
    } else {
      const newRefreshToken = this.refreshTokenRepository.create({
        hash_token: hashToken,
        expires_at: expiresAt,
        revoked_at: null,
        user: { id: refreshDto.id },
      });

      await this.refreshTokenRepository.save(newRefreshToken);
    }

    return refreshToken;
  }

  async refreshToken(refreshToken: string) {
    const payload = this.jwtService.verify(refreshToken, {
      secret: process.env.REFRESH_SECRET,
    });

    const user = await this.userService.findUserWithID(payload.sub);

    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    const newAccessTokenPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      first_name: user.first_name,
      last_name: user.last_name,
    };

    const newAccessToken = this.jwtService.sign(newAccessTokenPayload);

    const newRefreshToken = this.jwtService.sign(
      { id: user.id, username: user.username, role: user.role },
      {
        secret: process.env.REFRESH_SECRET,
        expiresIn: "7d",
      },
    );

    return {
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
    };
  }

  async validateRefreshToken(token: string) {
    const existing = await this.refreshTokenRepository.findOne({
      where: {
        hash_token: token,
      },
    });

    if (!existing) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    if (existing.revoked_at) {
      throw new UnauthorizedException("Refresh token has been revoked");
    }

    if (existing.expires_at < new Date()) {
      throw new UnauthorizedException("Refresh token expired");
    }

    return existing;
  }

  async revokeRefreshToken(token: string) {
    const existing = await this.refreshTokenRepository.findOne({
      where: { hash_token: token },
    });

    if (!existing) {
      throw new UnauthorizedException("Refresh token not found");
    }

    existing.revoked_at = new Date();
    await this.refreshTokenRepository.save(existing);

    return {
      message: "Refresh token revoked successfully",
    };
  }
}
