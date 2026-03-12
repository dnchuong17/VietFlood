import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export enum UserRole {
  CITIZEN = "citizen",
  ADMIN = "admin",
  OPERATOR = "operator",
}

@Entity("users")
export class UserEntity {
  @PrimaryGeneratedColumn("increment")
  id!: number;

  @Index({ unique: true })
  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Index({ unique: true })
  @Column({ type: "varchar", length: 60 })
  username!: string;

  @Column({ type: "varchar", length: 255 })
  password!: string;

  @Index({ unique: true })
  @Column({ type: "varchar", length: 20 })
  phone!: string;

  @Column({ type: "enum", enum: UserRole, default: UserRole.CITIZEN })
  role!: UserRole;

  @Column({ type: "varchar", length: 60 })
  first_name!: string;

  @Column({ type: "varchar", length: 60, nullable: true })
  middle_name: string;

  @Column({ type: "varchar", length: 60 })
  last_name!: string;

  @Column({ type: "date" })
  date_of_birth!: string;

  @Column({ type: "varchar", length: 255 })
  address_line!: string;

  @Column({ type: "varchar", length: 100 })
  ward!: string;

  @Column({ type: "varchar", length: 100 })
  district!: string;

  @Column({ type: "varchar", length: 100 })
  province!: string;

  @CreateDateColumn({ type: "timestamptz" })
  created_at!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updated_at!: Date;
}
