import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { ReportStatus } from "../enums/status.enum";

export type ReportEvidence = {
  url: string;
  publicId: string;
  resourceType?: string;
};

@Entity("reports")
export class ReportEntity {
  @PrimaryGeneratedColumn("increment")
  id: number;

  @Column("text", { array: true, nullable: true })
  category: string[];

  @Column({ type: "text" })
  description: string;

  @Column("text", { array: true, nullable: true })
  images: string[];

  @Column({ type: "jsonb", nullable: true, default: [] })
  evidences: ReportEvidence[];

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

  @Column()
  userId: number;
}
