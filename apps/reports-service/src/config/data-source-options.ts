import { DataSourceOptions } from "typeorm";
import * as dotenv from "dotenv";
import * as process from "node:process";

dotenv.config();

const dataSourceOptions: DataSourceOptions = {
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: ["dist/**/*.entity{.ts,.js}"],
  migrations: ["db/migrations/*{.ts,.js}"],
  synchronize: true,
  logging: ["error", "schema"],
  extra: {
    max: 2, 
    min: 1,
  },
};

export default dataSourceOptions;
