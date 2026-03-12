import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { UserEntity } from "./users.entity";
import { Repository } from "typeorm";
import { LoggerService, RedisService } from "@dnchuong17/vietflood-common";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly redisHelper: RedisService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setServiceName(UsersService.name);
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
}
