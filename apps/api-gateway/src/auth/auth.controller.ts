import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { SigninDto } from "./Dto/signIn.dto";
import { RegisterDto } from "./Dto/register.dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("sign_in")
  async signIn(@Body() signinDto: SigninDto) {
    return await this.authService.sign_in(signinDto);
  }

  @Post("register")
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Get("profile")
  profile(@Req() req: any) {
    console.log(req.user);
    return this.authService.profile(req);
  }

  @Post("refresh")
  async refresh(@Body() body: any) {
    return this.authService.refresh(body);
  }

  @Post("logout")
  async logout(@Body() body: any) {
    return this.authService.logout(body);
  }
}
