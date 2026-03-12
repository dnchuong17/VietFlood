import { DataSource } from "typeorm";
import dataSourceOptions from "./data-source-options";

export const dataSource = new DataSource(dataSourceOptions);
