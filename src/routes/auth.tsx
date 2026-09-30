import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { MiravikaLogo } from "@/components/brand/MiravikaLogo";
import { toast } from "sonner";
import {
  MIN_PASSWORD_LENGTH,
  RECOVERY_MESSAGES,
  authErrorMessage,
  buildRecoveryRedirect,
  recoveryStateFromLink,
  shouldRedirectToAdmin,
  validateNewPassword,
  wantsRecoveryMode,
  type AuthMode,
  type RecoveryState,
} from "@/lib/auth-recovery";

const IS_PRODUCTION = import.meta.env.PROD;

/**
 * The recovery link must point back at whichever origin the browser is actually
 * served from, so a deployed Worker on a custom domain gets a working link and
 * production can never emit a `localhost` URL.
 */
function currentOrigin() {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Staff Login | MIRAVIKA Commerce Core" },
      {
        name: "description",
        content: "Secure staff sign-in for the MIRAVIKA commerce control centre.",
      },
      { property: "og:title", content: "Staff Login | MIRAVIKA Commerce Core" },
      { property: "og:description", content: "Secure staff sign-in for MIRAVIKA admin." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<AuthMode>("signin");
  const [recoveryState, setRecoveryState] = useState<RecoveryState>("idle");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);

  // On mount, decide whether this visit is a password-recovery visit.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const search = window.location.search;
    const hash = window.location.hash;
    const requested = wantsRecoveryMode(search, hash);
    if (!requested) return;

    setMode("recovery");
    setRecoveryState("checking");

    let cancelled = false;
    // Supabase exchanges the one-time link for a short-lived recovery session.
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setRecoveryState("invalid");
          return;
        }
        setRecoveryState(recoveryStateFromLink(hash, Boolean(data.session)));
      })
      .catch(() => {
        if (!cancelled) setRecoveryState("invalid");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // A `PASSWORD_RECOVERY` event fires when the emailed link is consumed.
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        setMode("recovery");
        setRecoveryState("ready");
        return;
      }
      if (event === "SIGNED_OUT") {
        setRecoveryState((current) => (current === "ready" ? "invalid" : current));
        return;
      }
      if (event === "SIGNED_IN" && session) {
        setRecoveryState("updated");
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // Only leave the page once there is no recovery work in progress.
  useEffect(() => {
    if (mode === "recovery") return;
    let cancelled = false;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        const hasSession = Boolean(data.session);
        if (shouldRedirectToAdmin({ mode, hasSession, recoveryState })) {
          navigate({ to: "/admin" });
        }
      })
      .catch(() => {
        /* stay on the form if the session cannot be read */
      });
    return () => {
      cancelled = true;
    };
  }, [mode, recoveryState, navigate]);

  const setRecovery = useCallback((next: RecoveryState) => {
    setRecoveryState(next);
    setPassword("");
    setConfirmPassword("");
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "recovery") {
        const validation = validateNewPassword(password, confirmPassword);
        if (!validation.valid) {
          // Blocked client-side so a mismatched pair is never sent.
          toast.error(validation.error);
          return;
        }

        const { error } = await supabase.auth.updateUser({ password });
        if (error) {
          // A spent or rejected link reports here instead of on load.
          const message = authErrorMessage(error);
          setRecoveryState(/expired|already been used/i.test(message) ? "expired" : "ready");
          toast.error(message);
          return;
        }

        setRecovery("updated");
        toast.success(RECOVERY_MESSAGES.updated);
        // Return to sign-in with the recovery link no longer influencing the page.
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", "/auth");
        }
        setMode("signin");
        return;
      }

      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          toast.error(authErrorMessage(error));
          return;
        }
        navigate({ to: "/admin" });
      } else if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${currentOrigin()}/admin`,
            data: { full_name: fullName },
          },
        });
        if (error) {
          toast.error(authErrorMessage(error));
          return;
        }
        toast.success("Account created. An Owner must grant you a staff role.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          // Always the real browser origin + /auth?mode=recovery, never localhost.
          redirectTo: buildRecoveryRedirect(currentOrigin(), IS_PRODUCTION),
        });
        if (error) {
          toast.error(authErrorMessage(error));
          return;
        }
        toast.success("Password reset email sent if that account exists.");
      }
    } catch (error) {
      // Never log the raw error: it can carry tokens or the submitted password.
      toast.error(authErrorMessage(error as { message?: string | null } | null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-secondary px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-10 flex flex-col items-center">
          <MiravikaLogo size={96} />
          <h1 className="mt-6 font-display text-2xl tracking-[0.32em] text-foreground">MIRAVIKA</h1>
          <p className="mt-2 text-[10px] uppercase tracking-[0.45em] text-gold">Luxury Redefined</p>
        </div>

        <Card className="border-border/60 bg-card shadow-none">
          <CardContent className="p-8">
            <h2 className="font-display text-lg tracking-wide">
              {mode === "signin"
                ? "Staff Login"
                : mode === "signup"
                  ? "Request Staff Access"
                  : mode === "recovery"
                    ? "Set New Password"
                    : "Reset Password"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {mode === "signup"
                ? "New accounts stay locked until an Owner assigns a role."
                : mode === "recovery"
                  ? "Choose a new password to finish signing in."
                  : "Authorised MIRAVIKA staff only."}
            </p>

            {/* Explains an expired, invalid or already-used recovery link. */}
            {(recoveryState === "expired" || recoveryState === "invalid") && (
              <p
                role="status"
                className="mt-4 border border-border/60 bg-secondary/60 px-3 py-2 text-xs text-foreground"
              >
                {RECOVERY_MESSAGES[recoveryState]}{" "}
                <button
                  type="button"
                  className="underline underline-offset-4 hover:text-gold"
                  onClick={() => {
                    setRecovery("idle");
                    setMode("reset");
                  }}
                >
                  Request a new link
                </button>
              </p>
            )}

            <form onSubmit={submit} className="mt-6 space-y-4">
              {mode === "signup" && (
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-xs uppercase tracking-widest">
                    Full name
                  </Label>
                  <Input
                    id="name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                  />
                </div>
              )}
              {mode !== "recovery" && (
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-xs uppercase tracking-widest">
                    Email
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
              )}
              {mode === "recovery" ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="password" className="text-xs uppercase tracking-widest">
                      New password
                    </Label>
                    <Input
                      id="password"
                      type="password"
                      autoComplete="new-password"
                      minLength={MIN_PASSWORD_LENGTH}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirm-password" className="text-xs uppercase tracking-widest">
                      Confirm new password
                    </Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      autoComplete="new-password"
                      minLength={MIN_PASSWORD_LENGTH}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                    />
                    {confirmPassword.length > 0 && confirmPassword !== password && (
                      <p className="text-xs text-destructive">The new passwords do not match.</p>
                    )}
                  </div>
                </>
              ) : (
                mode !== "reset" && (
                  <div className="space-y-2">
                    <Label htmlFor="password" className="text-xs uppercase tracking-widest">
                      Password
                    </Label>
                    <Input
                      id="password"
                      type="password"
                      autoComplete={mode === "signin" ? "current-password" : "new-password"}
                      minLength={8}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </div>
                )
              )}
              <Button
                type="submit"
                disabled={busy || (mode === "recovery" && recoveryState !== "ready")}
                className="w-full tracking-[0.2em] uppercase text-xs"
              >
                {busy
                  ? "Please wait…"
                  : mode === "signin"
                    ? "Sign In"
                    : mode === "signup"
                      ? "Create Account"
                      : mode === "recovery"
                        ? "Update Password"
                        : "Send Reset Link"}
              </Button>
            </form>

            {/* Hidden mid-recovery so the form cannot be abandoned by accident. */}
            {mode === "recovery" ? (
              <div className="mt-6 text-center text-xs text-muted-foreground">
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => {
                    setRecovery("idle");
                    setMode("signin");
                  }}
                >
                  Back to sign in
                </button>
              </div>
            ) : (
              <div className="mt-6 flex justify-between text-xs text-muted-foreground">
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
                >
                  {mode === "signin" ? "Request access" : "Have an account?"}
                </button>
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => setMode("reset")}
                >
                  Forgot password
                </button>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground">
            Back to overview
          </Link>
        </p>
      </div>
    </main>
  );
}
