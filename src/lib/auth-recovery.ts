/**
 * Pure, client-safe rules for the staff sign-in and password-recovery flow.
 *
 * Kept separate from `src/routes/auth.tsx` so the security-relevant decisions
 * (where the reset link points, when a recovery link is still usable, and which
 * messages are safe to show) are unit-testable without a DOM.
 */

export const MIN_PASSWORD_LENGTH = 8;

export const AUTH_PATH = "/auth";
export const RECOVERY_QUERY = "mode=recovery";

export type AuthMode = "signin" | "signup" | "reset" | "recovery";

export type RecoveryState = "idle" | "checking" | "ready" | "expired" | "invalid" | "updated";

/**
 * Builds the post-reset landing URL from the *actual* browser origin.
 *
 * The origin is always taken from the running page so a deployed Worker on a
 * custom domain produces a real production link. In production a non-HTTPS or
 * loopback origin is rejected outright rather than sent to Supabase, so a reset
 * email can never point at `localhost`.
 */
export function buildRecoveryRedirect(origin: string, isProduction: boolean): string {
  const trimmed = origin.trim();
  if (!trimmed) throw new Error("Missing browser origin for the recovery link.");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid browser origin for the recovery link.");
  }

  if (isProduction) {
    if (parsed.protocol !== "https:") {
      throw new Error("The recovery link requires an HTTPS origin in production.");
    }
    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname.endsWith(".localhost");
    if (isLoopback) {
      throw new Error("The recovery link cannot target a loopback address in production.");
    }
  }

  // `mode=recovery` is what tells the auth page to show the set-new-password form.
  return `${parsed.origin}${AUTH_PATH}?${RECOVERY_QUERY}`;
}

/** True when the URL asks for the recovery form (query string or hash carrier). */
export function wantsRecoveryMode(search: string, hash: string): boolean {
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (new URLSearchParams(query).get("mode") === "recovery") return true;
  // Supabase can also return the intent through the hash on some redirect paths.
  return (hash.startsWith("#") ? hash.slice(1) : hash).includes(RECOVERY_QUERY);
}

/**
 * Supabase reports a dead recovery link either in the redirect hash
 * (`#error=access_denied&error_code=otp_expired`) or, on a replayed link, as an
 * `otp_expired` error from `getSession()`. A single-use link that was already
 * consumed lands here too, so the message covers both cases.
 */
export function recoveryStateFromLink(hash: string, hasRecoverySession: boolean): RecoveryState {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const code = (params.get("error_code") || params.get("error") || "").toLowerCase();

  if (code) {
    if (code.includes("expired")) return "expired";
    return "invalid";
  }
  // No error in the link: only a real recovery session makes the form usable.
  return hasRecoverySession ? "ready" : "idle";
}

export type PasswordValidation = { valid: true } | { valid: false; error: string };

/** Enforces the length floor and rejects a mismatched confirmation. */
export function validateNewPassword(password: string, confirm: string): PasswordValidation {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      valid: false,
      error: `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password !== confirm) {
    return { valid: false, error: "The new passwords do not match." };
  }
  return { valid: true };
}

/**
 * Whether the page should leave /auth for /admin.
 *
 * An existing session must never bounce the user away from the recovery form
 * before the new password is stored, and a rejected link must stay put so the
 * explanation stays readable.
 */
export function shouldRedirectToAdmin(input: {
  mode: AuthMode;
  hasSession: boolean;
  recoveryState: RecoveryState;
}): boolean {
  const { mode, hasSession, recoveryState } = input;
  if (recoveryState === "ready" || recoveryState === "checking") return false;
  if (mode === "recovery") return false;
  return hasSession && (mode === "signin" || mode === "signup");
}

/**
 * Maps a Supabase auth error onto a message that is safe to render.
 *
 * Only a fixed table of phrases is matched, so no token, email address, or raw
 * server payload can reach the UI or a log line.
 */
export function authErrorMessage(error: { message?: string | null } | null | undefined): string {
  const message = (error?.message ?? "").toLowerCase();

  if (!message) return "Something went wrong. Please try again.";
  if (message.includes("invalid login credentials")) {
    // Deliberately does not confirm whether the address exists.
    return "Incorrect email or password.";
  }
  if (message.includes("email not confirmed")) {
    return "This account still needs to confirm its email address.";
  }
  if (message.includes("user already registered")) {
    return "An account already exists for that email address.";
  }
  if (message.includes("password should be at least")) {
    return `Your password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (message.includes("rate limit") || message.includes("too many")) {
    return "Too many attempts. Please wait a moment and try again.";
  }
  if (message.includes("failed to fetch") || message.includes("network")) {
    return "We could not reach the authentication service. Please try again.";
  }
  if (message.includes("otp_expired") || message.includes("token has expired")) {
    return "This recovery link has expired or has already been used.";
  }
  if (message.includes("new password should be different")) {
    return "Choose a new password that differs from your current one.";
  }
  return "Something went wrong. Please try again.";
}

export const RECOVERY_MESSAGES: Record<
  Extract<RecoveryState, "expired" | "invalid" | "updated">,
  string
> = {
  expired: "This recovery link has expired or has already been used. Request a new one.",
  invalid: "This recovery link is not valid. Request a new password reset email.",
  updated: "Your password has been updated. Please sign in with your new password.",
};
