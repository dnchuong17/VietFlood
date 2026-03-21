import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as bcrypt from "bcrypt";

import { UserEntity, UserRole } from "../users/users.entity";
import { LoggerService } from "@dnchuong17/vietflood-common";

@Injectable()
export class AdminSeed implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setServiceName(AdminSeed.name);
  }

  async onApplicationBootstrap() {
    const adminEmail = process.env.ADMIN_EMAIL;

    const existed = await this.userRepository.findOne({
      where: { email: adminEmail },
    });

    if (existed) {
      this.logger.debug("Admin already exists");
      return;
    }

    const password = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);

    const admin = this.userRepository.create({
      email: adminEmail,
      username: "admin",
      password,
      phone: "0000000000",
      role: UserRole.ADMIN,
      first_name: "System",
      middle_name: null,
      last_name: "Admin",
      date_of_birth: "2000-01-01",
      province: "system",
      ward: "system",
      address_line: "system",
    });

    await this.userRepository.save(admin);

    this.logger.info("Default admin account created");
  }
}
