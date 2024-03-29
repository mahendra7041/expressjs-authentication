import express, {
  NextFunction,
  Request,
  Response,
  Router,
  query,
} from "express";
import { IController } from "../../constraints/controller";
import { validate } from "../../util/validate";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { User } from "@prisma/client";
import passport from "./passport.init";
import { HttpException } from "../../exception/http.exception";
import { HttpStatus } from "../../constraints/http-status.enum";
import { prisma } from "../../prisma/prisma.service";
import { excludeFields } from "../../util/helper";
import bcrypt from "bcryptjs";
import { AuthService } from "../../service/auth.service";
import { signedRouteVerify } from "../../middleware/signed-route-verify.middleware";
import { auth } from "../../middleware/auth.middleware";
import crypto from "crypto";

class AuthController implements IController {
  public readonly router: Router;
  public readonly prefix: string = "/auth";
  public readonly authService: AuthService;

  constructor() {
    this.authService = new AuthService();
    this.router = express.Router();
    this.initializeRouter();
  }

  private initializeRouter() {
    this.router.post("/user", auth, this.user);
    this.router.post("/register", this.register);
    this.router.post("/login", this.login);
    this.router.delete("/logout", this.logout);
    this.router.post(
      "/email/verification-notification",
      auth,
      this.sendEmailVerificationNotification.bind(this)
    );
    this.router.get(
      "/verify-email/:id/:hash",
      auth,
      signedRouteVerify,
      this.verifyEmail
    );
    this.router.post("/forgot-password", this.forgotPassword.bind(this));
    this.router.post("/reset-password", this.resetPassword.bind(this));
  }

  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = validate<Pick<User, "name" | "email" | "password">>(
        req.body,
        {
          name: "required|string",
          email: "required|email",
          password: "required|confirmed|min:8",
        }
      );

      const password = bcrypt.hashSync(
        validated.password,
        bcrypt.genSaltSync(10)
      );

      const user = await prisma.user.create({
        data: { ...validated, password },
      });

      req.logIn(excludeFields(user, ["password"]), (err) => {
        if (err) {
          throw new HttpException(
            "Internal Server Error",
            HttpStatus.INTERNAL_SERVER_ERROR
          );
        }

        return res.status(HttpStatus.CREATED).json({
          message: "User signup successfully",
          statusCode: HttpStatus.CREATED,
        });
      });
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
          message: "Validation Exception",
          errors: {
            email: ["Email address has already been taken"],
          },
        });
      }
      next(error);
    }
  }

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      validate<{ username: string; password: string }>(req.body, {
        username: "required|email",
        password: "required",
      });

      passport.authenticate(
        "local",
        function (error: any, user: User, info: any) {
          if (
            error instanceof PrismaClientKnownRequestError ||
            error === true
          ) {
            return res.status(HttpStatus.UNAUTHORIZED).json({
              message: "invalid credential",
              statusCode: HttpStatus.UNAUTHORIZED,
            });
          }

          if (error) {
            return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
              message: "Internal Server Error",
              statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            });
          }

          req.logIn(user, (err) => {
            if (err) {
              return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                message: "Internal Server Error",
                statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
              });
            }

            return res.status(HttpStatus.OK).json({
              message: "User login successfully",
              statusCode: HttpStatus.OK,
            });
          });
        }
      )(req, res, next);
    } catch (error) {
      next(error);
    }
  }

  async sendEmailVerificationNotification(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    try {
      await this.authService.sendEmailVerificationNotification(req.user!);

      res.json({
        message: "Your email verification link has been sent",
        statusCode: HttpStatus.OK,
      });
    } catch (error) {
      console.log(error);
      res.status(HttpStatus.BAD_GATEWAY).json({
        message: "Bad Gateway",
        statusCode: HttpStatus.BAD_GATEWAY,
      });
    }
  }

  async verifyEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await prisma.user.findUniqueOrThrow({
        where: {
          id: +req.params.id!,
        },
        select: {
          email: true,
          email_verified_at: true,
        },
      });

      const emailHash = crypto
        .createHash("sha1")
        .update(user.email)
        .digest("hex");

      if (req.params.hash !== emailHash) {
        return res.redirect(`${req.query.failedRedirect}?error=bad_request`);
      }

      if (!!user.email_verified_at) {
        return res.redirect(`${req.query.successRedirect}?verified=1`);
      }

      await prisma.user.update({
        where: {
          id: +req.params.id,
        },
        data: {
          email_verified_at: new Date(),
        },
      });

      return res.redirect(`${req.query.successRedirect}?verified=1`);
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === "P2025"
      ) {
        return res.redirect(`${req.query.failedRedirect}?error=bad_request`);
      }
      next(error);
    }
  }

  async forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = validate<{ email: string }>(req.body, {
        email: "required|email",
      });

      await this.authService.forgotPassword(validated.email);

      return res.status(HttpStatus.OK).json({
        message: "password reset link has been sent",
        statusCode: HttpStatus.OK,
      });
    } catch (error) {
      next(error);
    }
  }

  async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const validated = validate(
        <{ email: string; password: string; token: string }>req.body,
        {
          token: "required|string",
          email: "required|email",
          password: "required|confirmed|min:8",
        }
      );

      await this.authService.resetPassword(validated);

      res.status(HttpStatus.OK).json({
        message: "Your password has been reset successfully",
        statusCode: HttpStatus.OK,
      });
    } catch (error) {
      next(error);
    }
  }

  user(req: Request, res: Response) {
    return res.json(req.user);
  }

  logout(req: Request, res: Response) {
    req.logout(() => {
      req.session.destroy(function () {});
    });
    res.status(HttpStatus.NO_CONTENT).json({});
  }
}

export default new AuthController();
