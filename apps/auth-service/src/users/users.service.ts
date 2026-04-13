import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { UserEntity } from "./users.entity";
import { Repository } from "typeorm";
import { LoggerService, RedisService } from "vietflood-common";
import { UpdateUserDto } from "../DTO/update_user.dto";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly logger: LoggerService,
    private readonly redisHelper: RedisService,
  ) {
    this.logger.setServiceName(UsersService.name);
  }
  async getAllUsers() {
    this.logger.debug(`[GET ALL USERS] - Find all users`);

    const users = await this.userRepository.find();
    return users;
  }

  async findAccountWithEmail(email: string) {
    this.logger.debug(`[FIND USER]-Find user via email ${email}`);
    const cacheUser = await this.redisHelper.get(email);
    if (cacheUser) {
      this.logger.debug("Found user from cache");
      return JSON.parse(cacheUser);
    }

    const user = await this.userRepository.findOne({
      where: [{ email: email }],
    });
    if (user) {
      await this.redisHelper.set(user.email, JSON.stringify(user));
    }

    return user;
  }

  async findUserWithUsername(username: string) {
    this.logger.debug(`[FIND USER] - Finding user via username: ${username}`);
    const user = await this.userRepository.findOne({
      where: [{ username: username }],
    });
    return user;
  }

  async findUserWithPhone(phone: string) {
    this.logger.debug(`[FIND USER] - Finding user via username: ${phone}`);
    const user = await this.userRepository.findOne({
      where: [{ phone: phone }],
    });
    return user;
  }

  async findUserWithID(id: number) {
    if (!id) {
      this.logger.error("[FIND USER] - ID is undefined or invalid");
      throw new BadRequestException("Invalid ID");
    }

    this.logger.debug(`[FIND USER] - Finding user via  ID: ${id}`);

    const user = await this.userRepository.findOne({
      where: { id: id },
    });

    if (!user) {
      this.logger.error(`[FIND USER] - User not found for ID: ${id}`);
      throw new BadRequestException(`User not found for ID: ${id}`);
    }

    this.logger.debug(
      `[FIND USER] - User found: ${JSON.stringify({ id: user.id, username: user.username })}`,
    );
    delete user.password;

    return user;
  }

  async updateUserProfile(id: number, updateUserDto: UpdateUserDto) {
    if (!id) {
      this.logger.error("[UPDATE USER] - ID is undefined or invalid");
      throw new BadRequestException("Invalid ID");
    }
    this.logger.debug(`[UPDATE USER] - Updating user with ID: ${id}`);

    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      this.logger.error(`[UPDATE USER] - User not found for ID: ${id}`);
      throw new NotFoundException(`User not found for ID: ${id}`);
    }

    const updatedUser = await this.userRepository.update(id, {
      ...updateUserDto,
    });
    this.logger.debug(
      `[UPDATE USER] - User updated successfully: ${JSON.stringify({
        id: id,
      })}`,
    );

    return {
      success: true,
      message: "Update user successfully",
      userId: id,
    };
  }

  async updateUserById(userId: number, updateUserDto: UpdateUserDto) {
    if (!userId) {
      this.logger.error("[UPDATING USER BY ID] - ID is undefined or invalid");
      throw new BadRequestException("Invalid ID");
    }
    this.logger.debug(
      `[UPDATING USER BY ID] - Updating user with ID: ${userId}`,
    );

    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      this.logger.error(
        `[UPDATING USER BY ID] - User not found for ID: ${userId}`,
      );
      throw new NotFoundException(`User not found for ID: ${userId}`);
    }

    const updatedUser = await this.userRepository.update(
      { id: userId },
      {
        ...updateUserDto,
      },
    );
    this.logger.debug(
      `[UPDATE USER] - User updated successfully: ${JSON.stringify({
        id: userId,
      })}`,
    );

    return {
      success: true,
      message: "Update user successfully",
      userId: userId,
    };
  }

  async deleteUser(userId: number) {
    if (!userId) {
      this.logger.error("[DELETE USER] - ID is undefined or invalid");
      throw new BadRequestException("Invalid ID");
    }
    this.logger.debug(`[DELETE USER] - Deleting user with ID: ${userId}`);

    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      this.logger.error(`[DELETE USER] - User not found for ID: ${userId}`);
      throw new NotFoundException(`User not found for ID: ${userId}`);
    }

    await this.userRepository.delete({ id: userId });

    this.logger.debug(
      `[DELETE USER] - User deleted successfully: ${JSON.stringify({
        id: userId,
      })}`,
    );

    return {
      success: true,
      message: "Delete user successfully",
      userId: userId,
    };
  }
}
