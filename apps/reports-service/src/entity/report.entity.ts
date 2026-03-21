import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { ReportCategory } from "../enums/report_type.enum";
import { ReportStatus } from "../enums/status.enum";

@Entity("reports")
export class ReportEntity {
  @PrimaryGeneratedColumn("increment")
  id: number;

  @Column({
    type: "enum",
    enum: ReportCategory,
  })
  category: ReportCategory;

  @Column({ type: "float", nullable: true })
  waterLevel: number;

  @Column({ type: "text" })
  description: string;

  @Column("text", { array: true, nullable: true })
  images: string[];

  @Column({ type: "jsonb", nullable: true })
  evidences: {
    url: string;
    publicId: string;
    resourceType?: string;
  }[];

  @Column()
  province: string;

  @Column()
  ward: string;

  @Column()
  addressLine: string;

  @Column({ type: "float", nullable: true })
  lat: number;

  @Column({ type: "float", nullable: true })
  lng: number;

  @Column({
    type: "enum",
    enum: ReportStatus,
    default: ReportStatus.PENDING,
  })
  status: ReportStatus;

  @Column({ nullable: true })
  createdBy: string;

  @Column({ default: false })
  isUrgent: boolean;

  @Column({ default: 0 })
  severity: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ nullable: true })
  userId: number;
}
