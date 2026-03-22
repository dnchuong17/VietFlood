import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthService } from "./auth.service";
import { SigninDto } from "./Dto/signIn.dto";
import { RegisterDto } from "./Dto/register.dto";
import { JwtAuthGuard } from "./guard/jwt-auth.guard";
import { UpdateUserDto } from "./Dto/update_user.dto";
import { RolesGuard } from "./guard/role.guard";
import { Roles } from "./Decorators/role.decorator";
import { RefreshJwtAuthGuard } from "./guard/refresh-jwt-auth.guard";

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
  @UseGuards(JwtAuthGuard)
  profile(@Req() req: any) {
    return this.authService.profile(req.user);
  }

  @Put("update")
  @UseGuards(JwtAuthGuard)
  async updateProfile(@Req() req: any, @Body() updateUserDto: UpdateUserDto) {
    return this.authService.updateProfile(req.user.userId, updateUserDto);
  }

  @Put("update/user/:id")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("admin")
  async updateUserById(
    @Param("id", ParseIntPipe) id: number,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return this.authService.updateUserById(id, updateUserDto);
  }

  @Delete("delete/:id")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("admin")
  async deleteUser(@Param("id", ParseIntPipe) id: number) {
    return this.authService.deleteUser(id);
  }

  @Get("all")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("admin")
  async getAllUsers() {
    return this.authService.getAllUsers();
  }

  @Post("refresh")
  async refresh(@Body() body: any) {
    return this.authService.refresh(body);
  }

  @Post("refresh_token")
  @UseGuards(RefreshJwtAuthGuard)
  async refreshToken(@Body() body: any) {
    return this.authService.refreshToken(body.refresh);
  }

  @Post("logout")
  async logout(@Body() body: any) {
    return this.authService.logout(body);
  }
}
