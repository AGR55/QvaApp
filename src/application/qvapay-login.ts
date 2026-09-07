import type { LoginResult } from "../qvapay.js";

export interface QvaLoginGateway {
  login(email: string, password: string, twoFactorCode?: string): Promise<LoginResult>;
}

export interface AuthenticateQvaSessionOptions {
  email: string;
  password: string;
  gateway: QvaLoginGateway;
  requestCode: (kind: "otp" | "pin") => Promise<string>;
  verifyToken: (token: string) => Promise<void>;
  saveToken: (token: string) => void;
}

export async function authenticateQvaSession(
  options: AuthenticateQvaSessionOptions,
): Promise<void> {
  const email = options.email.trim();
  if (!email || !email.includes("@")) throw new Error("El correo de QvaPay no es válido.");
  if (!options.password) throw new Error("La contraseña de QvaPay es obligatoria.");

  let result = await options.gateway.login(email, options.password);
  if (result.requiresTwoFactor) {
    const kind = result.hasOtp ? "otp" : "pin";
    const code = (await options.requestCode(kind)).trim();
    const expected = kind === "otp" ? /^\d{6}$/ : /^\d{4}$/;
    if (!expected.test(code))
      throw new Error(
        kind === "otp"
          ? "El código de la aplicación autenticadora debe tener exactamente seis dígitos."
          : "El PIN de QvaPay debe tener exactamente cuatro dígitos.",
      );
    result = await options.gateway.login(email, options.password, code);
  }

  if (result.requiresTwoFactor || !result.token)
    throw new Error("QvaPay no confirmó el inicio de sesión.");
  await options.verifyToken(result.token);
  options.saveToken(result.token);
}
