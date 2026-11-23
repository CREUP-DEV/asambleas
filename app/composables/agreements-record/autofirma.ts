/**
 * Signing a PDF with AutoFirma from the browser, as the Intranet signs its
 * attendance certificates: its client script (public/autofirma, loaded on
 * demand by the app's own code, which the CSP's `strict-dynamic` trusts)
 * launches the signer's AutoFirma through an `afirma:` link and talks to it
 * on 127.0.0.1 (both allowed by the CSP, nuxt.config.ts). The signature is a
 * PAdES one over SHA-512, added as a new revision of the PDF
 * (`alwaysCreateRevision`), so the signed file keeps the prepared one whole.
 */

interface AutoScriptClient {
  cargarAppAfirma: () => void;
  sign: (
    dataB64: string,
    algorithm: string,
    format: string,
    params: string,
    onSuccess: (signatureB64: string) => void,
    onError: (errorType: string, errorMessage: string) => void,
  ) => void;
}

declare global {
  interface Window {
    AutoScript?: AutoScriptClient;
  }
}

const SCRIPT_URL = "/autofirma/autoscript.js";
const SIGN_PARAMS = "alwaysCreateRevision=true\n";

let loading: Promise<AutoScriptClient> | null = null;

/** The AutoFirma client, its script loaded the first time it is asked for. */
export function loadAutoFirma(): Promise<AutoScriptClient> {
  if (window.AutoScript) return Promise.resolve(window.AutoScript);
  loading ??= new Promise<AutoScriptClient>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (window.AutoScript) resolve(window.AutoScript);
      else reject(new Error("AutoFirma client missing"));
    };
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("AutoFirma client not loaded"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** Base64 of bytes, in chunks (a large PDF overflows one spread call). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** The signer cancelled in AutoFirma: not an error to report. */
export class AutoFirmaCancelledError extends Error {}

/**
 * Signs `pdf` with the certificate the signer picks in AutoFirma and
 * answers the signed PDF. Rejects with AutoFirmaCancelledError when they
 * cancel, and with an Error when AutoFirma cannot be reached.
 */
export async function signWithAutoFirma(pdf: Uint8Array): Promise<Uint8Array> {
  const client = await loadAutoFirma();
  client.cargarAppAfirma();
  const signed = await new Promise<string>((resolve, reject) => {
    client.sign(
      bytesToBase64(pdf),
      "SHA512",
      "PAdES",
      SIGN_PARAMS,
      resolve,
      (errorType, errorMessage) => {
        const cancelled = /cancel/i.test(`${errorType} ${errorMessage}`);
        reject(
          cancelled
            ? new AutoFirmaCancelledError(errorMessage)
            : new Error(`${errorType}: ${errorMessage}`),
        );
      },
    );
  });
  return base64ToBytes(signed);
}
