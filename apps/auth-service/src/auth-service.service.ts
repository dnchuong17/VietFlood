import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { UsersService } from "./users/users.service";
import { InjectRepository } from "@nestjs/typeorm";
import { UserEntity } from "./users/users.entity";
import { Repository } from "typeorm";
import { JwtService } from "@nestjs/jwt";
import { LoggerService } from "vietflood-common";
import { RegisterDto } from "./DTO/register.dto";
import * as bcrypt from "bcrypt";
import { plainToInstance } from "class-transformer";
import { SigninDto } from "./DTO/signIn.dto";
import { RefreshTokenService } from "./refesh_token/refresh_token.service";
import { UpdateUserDto } from "./DTO/update_user.dto";

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UsersService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly jwtService: JwtService,
    private readonly logger: LoggerService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {
    logger.setServiceName(AuthService.name);
  }

  async register(registerDto: RegisterDto) {
    this.logger.debug("register");
    const existedEmail = await this.userService.findAccountWithEmail(
      registerDto.email,
    );
    if (existedEmail) {
      throw new BadRequestException("Email already in use");
    }

    const existedUsername = await this.userService.findUserWithUsername(
      registerDto.username,
    );
    if (existedUsername) {
      throw new BadRequestException("Username already in use");
    }

    const existedPhone = await this.userService.findUserWithPhone(
      registerDto.phone,
    );
    if (existedPhone) {
      throw new BadRequestException("Phone already in use");
    }

    try {
      const hashPassword = await bcrypt.hash(registerDto.password, 10);
      const newUser = plainToInstance(UserEntity, {
        ...registerDto,
        password: hashPassword,
      });
      const user = await this.userRepository.save(newUser);

      return "register successfully";
    } catch (error) {
      throw new BadRequestException(error);
    }
  }

  async validateUser(username: string, password: string) {
    const user = await this.userService.findUserWithUsername(username);
    try {
      if (user && (await bcrypt.compare(password, user.password))) {
        const { password, ...result } = user;
        return result;
      }
    } catch (error) {
      throw new UnauthorizedException(error);
    }
    return null;
  }

  async signIn(signIn: SigninDto) {
    const isSignIn = await this.validateUser(signIn.username, signIn.password);
    if (isSignIn) {
      const user = await this.userService.findUserWithUsername(signIn.username);
      const payload = {
        sub: user.id,
        username: user.username,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name,
      };

      const accessToken = this.jwtService.sign(payload);
      const refreshDto = {
        id: user.id,
        username: user.username,
        role: user.role,
      };

      const refresh_token =
        await this.refreshTokenService.createRefreshToken(refreshDto);
      return {
        accessToken,
        refresh_token,
      };
    } else {
      throw new UnauthorizedException("Invalid username or password");
    }
  }

  async getAllUsers() {
    this.logger.debug("[ALL USERS] - Getting all users");
    return this.userService.getAllUsers();
  }

  async getUserById(userId: number) {
    this.logger.debug("[GET USER] - Getting user by id");
    return this.userService.findUserWithID(userId);
  }

  async profile(userId: number) {
    this.logger.debug(`[PROFILE] - Fetching profile for userId: ${userId}`);
    return this.userService.findUserWithID(userId);
  }

  async userUpdate(userId: number, userUpdateDto: UpdateUserDto) {
    this.logger.debug(`[UPDATE USER] - Updating profile for userId: ${userId}`);
    return this.userService.updateUserProfile(userId, userUpdateDto);
  }

  async userUpdateByID(userId: number, userUpdateDto: UpdateUserDto) {
    this.logger.debug(
      `[UPDATE USER BY ID] - Updating profile for userId: ${userId}`,
    );
    return this.userService.updateUserById(userId, userUpdateDto);
  }

  async deleteUser(userId: number) {
    this.logger.debug(`[DELETE USER] - Deleting profile for userId: ${userId}`);
    return this.userService.deleteUser(userId);
  }
}
