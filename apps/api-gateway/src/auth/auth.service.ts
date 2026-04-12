import { Inject, Injectable } from "@nestjs/common";
import { catchError, lastValueFrom, of, retry, timeout } from "rxjs";
import { ClientProxy } from "@nestjs/microservices";
import { RegisterDto } from "./Dto/register.dto";
import { SigninDto } from "./Dto/signIn.dto";
import { UpdateUserDto } from "./Dto/update_user.dto";

@Injectable()
export class AuthService {
  constructor(
    @Inject("AUTH_SERVICE") private readonly auth_service: ClientProxy,
  ) {}

  async register(registerDto: RegisterDto) {
    const data = await lastValueFrom(
      this.auth_service.send("register", registerDto).pipe(
        timeout(5000),
        retry(3),
        catchError((error) => {
          return of({ error: "auth service error!", details: error });
        }),
      ),
    );
    return data;
  }

  async sign_in(signinDto: SigninDto) {
    const data = await lastValueFrom(
      this.auth_service.send("sign_in", signinDto).pipe(
        timeout(5000),
        retry(3),
        catchError((error) => {
          return of({ error: "auth service error!", details: error });
        }),
      ),
    );
    return data;
  }

  async profile(user: any) {
    const data = await lastValueFrom(
      this.auth_service.send("profile", { user }).pipe(
        timeout(5000),
        retry(3),
        catchError((error) => {
          return of({ error: "auth service error!", details: error });
        }),
      ),
    );
    return data;
  }

  async getAllUsers() {
    const data = await lastValueFrom(
      this.auth_service.send("all", "").pipe(
        timeout(5000),
        retry(3),
        catchError((error) => {
          return of({ error: "auth service error!", details: error });
        }),
      ),
    );
    return data;
  }

  async getUserById(userId: number) {
    const data = await lastValueFrom(
      this.auth_service.send("get_user", { userId }).pipe(
        timeout(5000),
        retry(3),
        catchError((error) => {
          return of({ error: "auth service error!", details: error });
        }),
      ),
    );
    return data;
  }

  async updateProfile(userId: number, updateUserDto: UpdateUserDto) {
    const data = await lastValueFrom(
      this.auth_service
        .send("update", {
          userId,
          updateUserDto,
        })
        .pipe(
          timeout(5000),
          retry(3),
          catchError((error) => {
            return of({ error: "auth service error!", details: error });
          }),
        ),
    );
    return data;
  }

  async updateUserById(userId: number, updateUserDto: UpdateUserDto) {
    const data = await lastValueFrom(
      this.auth_service
        .send("update", {
          userId,
          updateUserDto,
        })
        .pipe(
          timeout(5000),
          retry(3),
          catchError((error) => {
            return of({ error: "auth service error!", details: error });
          }),
        ),
    );
    return data;
  }

  async deleteUser(userId: number) {
    const data = await lastValueFrom(
      this.auth_service
        .send("delete", {
          userId,
        })
        .pipe(
          timeout(5000),
          retry(3),
          catchError((error) => {
            return of({ error: "auth service error!", details: error });
          }),
        ),
    );
    return data;
  }

  async refresh(dataPayload: any) {
    const data = await lastValueFrom(
      this.auth_service.send("refresh", dataPayload).pipe(
        timeout(5000),
        retry(3),
        catchError((error) => {
          return of({ error: "auth service error!", details: error });
        }),
      ),
    );
    return data;
  }

  async refreshToken(dataPayload: any) {
    const data = await lastValueFrom(
      this.auth_service.send("refresh_token", dataPayload).pipe(
        timeout(5000),
        retry(3),
        catchError((error) => {
          return of({ error: "auth service error!", details: error });
        }),
      ),
    );
    return data;
  }

  async logout(dataPayload: any) {
    const data = await lastValueFrom(
      this.auth_service.send("logout", dataPayload).pipe(
        timeout(5000),
        retry(3),
        catchError((error) => {
          return of({ error: "auth service error!", details: error });
        }),
      ),
    );
    return data;
  }
}
