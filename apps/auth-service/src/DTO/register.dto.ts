import { UserRole } from "../users/users.entity";

export class RegisterDto {
  email!: string;
  username!: string;
  password!: string;
  phone!: string;
  first_name!: string;
  middle_name?: string;
  last_name!: string;
  date_of_birth!: string;
  province!: string;
  ward!: string;
  address_line!: string;
  role?: UserRole;
}
