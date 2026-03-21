import {
  TypeOrmModuleAsyncOptions,
  TypeOrmModuleOptions,
} from "@nestjs/typeorm";
import dataSourceOptions from "./data-source-options";

export const typeormConfig: TypeOrmModuleOptions = dataSourceOptions;
export const typeOrmConfigAsync: TypeOrmModuleAsyncOptions = {
  useFactory: async (): Promise<TypeOrmModuleOptions> => {
    return typeormConfig;
  },
};
