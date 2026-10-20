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
    // Retire idle sockets before a database proxy can leave them stale.
    min: 0,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    maxLifetimeSeconds: 60,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  },
};

export default dataSourceOptions;
