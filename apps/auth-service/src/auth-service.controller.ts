import { Controller, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth-service.service";
import { LoggerService } from "@dnchuong17/vietflood-common";
import { MessagePattern, Payload, RpcException } from "@nestjs/microservices";
import { RefreshTokenService } from "./refesh_token/refresh_token.service";
import { RefreshJwtAuthGuard } from "./guard/refresh-jwt-auth.guard";

@Controller()
export class AuthServiceController {
  constructor(
    private readonly authService: AuthService,
    private readonly logger: LoggerService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {
    logger.setServiceName(AuthServiceController.name);
  }

  @MessagePattern("register")
  async register(@Payload() data) {
    try {
      this.logger.debug("receive request register");
      return await this.authService.register(data);
    } catch (error) {
      throw new RpcException(error);
    }
  }
  @MessagePattern("sign_in")
  async sign_in(@Payload() data) {
    try {
      this.logger.debug("receive request sign in");
      return await this.authService.signIn(data);
    } catch (error) {
      throw new RpcException(error);
    }
  }

  @MessagePattern("profile")
  async profile(@Payload() data) {
    try {
      this.logger.debug("receive request profile");
      return await this.authService.profile(data.user.userId);
    } catch (error) {
      throw new RpcException(error);
    }
  }

  @MessagePattern("all")
  async getAllUsers() {
    try {
      this.logger.debug("receive request get all users");
      return await this.authService.getAllUsers();
    } catch (error) {
      throw new RpcException(error);
    }
  }

  @MessagePattern("update")
  async updateUser(@Payload() data: any) {
    try {
      this.logger.debug(
        `[UPDATE USER] - receive request update for userId: ${data.userId}`,
      );

      return await this.authService.userUpdate(data.userId, data.updateUserDto);
    } catch (error) {
      this.logger.error(
        `[UPDATE USER] - failed for userId: ${data?.userId}, error: ${error?.message}`,
      );
      throw new RpcException(error);
    }
  }

  @MessagePattern("update/user")
  async updateUserById(@Payload() data: any) {
    try {
      this.logger.debug(
        `[UPDATE USER BY ID] - receive request update for userId: ${data.userId}`,
      );

      return await this.authService.userUpdateByID(
        data.userId,
        data.updateUserDto,
      );
    } catch (error) {
      this.logger.error(
        `[UPDATE USER BY ID] - failed for userId: ${data?.userId}, error: ${error?.message}`,
      );
      throw new RpcException(error);
    }
  }

  @MessagePattern("delete")
  async deleteUser(@Payload() data: any) {
    try {
      this.logger.debug(
        `[DELETE USER] - receive request update for userId: ${data.userId}`,
      );

      return await this.authService.deleteUser(data.userId);
    } catch (error) {
      this.logger.error(`[DELETE USER] - failed for userId: ${data.userId}`);
      throw new RpcException(error);
    }
  }

  @UseGuards(RefreshJwtAuthGuard)
  @MessagePattern("refresh")
  async refresh(@Payload() data) {
    try {
      this.logger.debug("receive request refresh token");
      return await this.refreshTokenService.createRefreshToken(data);
    } catch (error) {
      throw new RpcException(error);
    }
  }

  @MessagePattern("logout")
  async logout(@Payload() data) {
    try {
      this.logger.debug("receive request logout");
      return await this.refreshTokenService.revokeRefreshToken(data);
    } catch (error) {
      throw new RpcException(error);
    }
  }
}
