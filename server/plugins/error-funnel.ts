import { funnelUnhandledError } from "../utils/errors";

/**
 * Puts `funnelUnhandledError` in front of the app's error handling (ARQ-4):
 * h3 hands every error a handler did not catch to the app's `onError`,
 * Nitro's, which passes it to Nuxt's and Nitro's error handlers, and those
 * log an unhandled one whole. h3 reads `onError` from the app's options each
 * time, so wrapping it here covers every request, also those Nitro sends
 * itself (`localFetch`).
 */
export default defineNitroPlugin((nitroApp) => {
  const options = nitroApp.h3App.options;
  const handle = options.onError;
  options.onError = (error, event) => {
    funnelUnhandledError(error, event);
    return handle?.(error, event);
  };
});
