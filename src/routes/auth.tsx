import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { MiravikaLogo } from "@/components/brand/MiravikaLogo";
import { toast } from "sonner";

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
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/admin" });
    });
  }, [navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/admin" });
      } else if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/admin`,
            data: { full_name: fullName },
          },
        });
        if (error) throw error;
        toast.success("Account created. An Owner must grant you a staff role.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth`,
        });
        if (error) throw error;
        toast.success("Password reset email sent if that account exists.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong.");
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
                  : "Reset Password"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {mode === "signup"
                ? "New accounts stay locked until an Owner assigns a role."
                : "Authorised MIRAVIKA staff only."}
            </p>

            <form onSubmit={submit} className="mt-6 space-y-4">
              {mode === "signup" && (
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-xs uppercase tracking-widest">
                    Full name
                  </Label>
                  <Input id="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
                </div>
              )}
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
              {mode !== "reset" && (
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
              )}
              <Button
                type="submit"
                disabled={busy}
                className="w-full tracking-[0.2em] uppercase text-xs"
              >
                {busy
                  ? "Please wait…"
                  : mode === "signin"
                    ? "Sign In"
                    : mode === "signup"
                      ? "Create Account"
                      : "Send Reset Link"}
              </Button>
            </form>

            <div className="mt-6 flex justify-between text-xs text-muted-foreground">
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              >
                {mode === "signin" ? "Request access" : "Have an account?"}
              </button>
              <button type="button" className="hover:text-foreground" onClick={() => setMode("reset")}>
                Forgot password
              </button>
            </div>
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
