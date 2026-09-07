import { stdin, stdout, stderr } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { authenticateQvaSession } from "./application/qvapay-login.js";
import { config } from "./config.js";
import { QvaApiError, QvaConnectionError, QvaPayClient } from "./qvapay.js";
import { Session } from "./session.js";
import { Store } from "./store.js";
import { Vault } from "./vault.js";

class SecretOutput extends Writable {
  muted = false;

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) stdout.write(chunk);
    callback();
  }
}

const secretOutput = new SecretOutput();
const prompt = createInterface({
  input: stdin,
  output: secretOutput,
  terminal: Boolean(stdin.isTTY),
});

async function secretQuestion(label: string): Promise<string> {
  stdout.write(label);
  secretOutput.muted = true;
  try {
    return await prompt.question("");
  } finally {
    secretOutput.muted = false;
    stdout.write("\n");
  }
}

const store = new Store(config.dataDir);
try {
  const email = (await prompt.question("Correo de QvaPay: ")).trim();
  const password = await secretQuestion("Contraseña de QvaPay: ");
  const client = new QvaPayClient(() => undefined);
  const session = new Session(store, new Vault(config.encryptionKey));
  await authenticateQvaSession({
    email,
    password,
    gateway: client,
    requestCode: async (kind) => {
      stdout.write(
        kind === "otp"
          ? "QvaPay solicita el código actual de tu aplicación autenticadora.\n"
          : "QvaPay solicitó un PIN. Revisa correo, Spam y Promociones.\n",
      );
      return secretQuestion(
        kind === "otp" ? "Código TOTP de 6 dígitos: " : "PIN de 4 dígitos: ",
      );
    },
    verifyToken: async (token) => {
      await new QvaPayClient(() => token).profile();
    },
    saveToken: (token) => session.save(token),
  });
  stdout.write("Sesión verificada y guardada de forma cifrada. Ya puedes iniciar el bot.\n");
} catch (error) {
  stderr.write(`${loginErrorMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  prompt.close();
  store.close();
}

export function loginErrorMessage(error: unknown): string {
  if (error instanceof QvaConnectionError)
    return `No se pudo iniciar sesión: ${error.message}`;
  if (error instanceof QvaApiError) {
    if (error.status === 401)
      return "QvaPay rechazó las credenciales o el código TOTP. Comprueba que el código sea el actual e inténtalo de nuevo.";
    if (error.status === 403)
      return "QvaPay bloqueó el acceso por seguridad. Revisa tu cuenta y cambia la contraseña si lo solicita.";
    if (error.status === 423)
      return "La cuenta está bloqueada temporalmente por varios intentos. Espera antes de volver a probar.";
    if (error.status === 429)
      return "QvaPay limitó los intentos de login. Espera unos minutos antes de volver a probar.";
    return `QvaPay rechazó el inicio de sesión (${error.status}): ${error.message}`;
  }
  return error instanceof Error
    ? `No se pudo iniciar sesión: ${error.message}`
    : "No se pudo iniciar sesión por un error desconocido.";
}
