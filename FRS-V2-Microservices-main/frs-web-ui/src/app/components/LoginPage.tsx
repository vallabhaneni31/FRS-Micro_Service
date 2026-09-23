import React, { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Lock, Mail, AlertCircle, Eye, EyeOff, Loader2, Globe, Sun, Moon,
  ScanFace, Zap, ShieldCheck, ArrowRight, CheckCircle2, Fingerprint, Sparkles, AlertTriangle, Clock,
} from "lucide-react";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { apiRequest, ApiError } from "../services/http/apiClient";
import { MfaVerifyPage } from "./auth/MfaVerifyPage";
import { authConfig } from "../config/authConfig";
import keycloak, { realmFromSubdomain } from "../services/auth/keycloakInstance";

// AB#3267: only worth surfacing the remaining-attempts hint when the count is
// low enough to actually be useful/urgent — a large number (e.g. still 8 of 10
// left) is just noise. Mirrors typical brute-force thresholds used elsewhere
// in this app (AB#2730's failureFactor defaults are commonly 3-5).
const REMAINING_ATTEMPTS_WARNING_THRESHOLD = 3;

/** Appends the AB#3267 remaining-attempts hint to an auth error message, when useful. Exported for direct unit testing. */
export function withRemainingAttemptsHint(message: string, remainingAttempts?: number): string {
  if (typeof remainingAttempts !== "number" || remainingAttempts < 1 || remainingAttempts > REMAINING_ATTEMPTS_WARNING_THRESHOLD) {
    return message;
  }
  const attemptWord = remainingAttempts === 1 ? "attempt" : "attempts";
  return `${message} ${remainingAttempts} ${attemptWord} remaining before your account is temporarily locked.`;
}

export const LoginPage: React.FC = () => {
  const { login, loginWithKeycloakToken, isAuthLoading, isAuthenticated, authError, clearAuthError } = useAuth();

  // Tenant is identified dynamically from the URL subdomain
  // (e.g. acme.frs.motivitylabs.com → realm "acme"). When present, the user
  // never types a workspace slug. Falls back to the manual field on apex/localhost.
  const subdomainRealm = realmFromSubdomain();

  // ?realm=motivity-internal in the URL means we navigated here from a validated
  // workspace submission so that the keycloakInstance module reloads with the
  // correct realm. Auto-trigger KC login once init is done.
  const autoLoginRealm = new URLSearchParams(window.location.search).get("realm");

  const [email, setEmail] = useState(localStorage.getItem("frs_remembered_email") || "");
  const [password, setPassword] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState(
    autoLoginRealm || localStorage.getItem("frs_current_realm") || ""
  );
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; workspace?: string }>({});
  const [isValidating, setIsValidating] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(!!localStorage.getItem("frs_remembered_email"));
  const [redirecting, setRedirecting] = useState(false);
  const [mfaChallengeToken, setMfaChallengeToken] = useState<string | null>(null);
  // "workspace" = slug entry, "credentials" = email+password after workspace validated
  const [phase, setPhase] = useState<"workspace" | "credentials">(
    autoLoginRealm || subdomainRealm ? "credentials" : "workspace"
  );
  const [resolvedRealm, setResolvedRealm] = useState(autoLoginRealm || subdomainRealm || "");

  // A subdomain resolving via nginx/DNS wildcard is not the same as a provisioned
  // tenant — without this gate, any random-string.<base-domain> skipped straight to
  // a fully working credentials form for a workspace that doesn't exist. Run the same
  // /auth/workspace/validate check the manual-entry "workspace" phase already uses
  // (see handleSubmit below) before trusting a subdomain-derived realm.
  // autoLoginRealm is already-validated (see its comment above), so it skips this gate.
  const [subdomainGate, setSubdomainGate] = useState<"pending" | "ok" | "blocked">(
    subdomainRealm && authConfig.mode === "keycloak" && !autoLoginRealm ? "pending" : "ok"
  );
  const [subdomainError, setSubdomainError] = useState<string | null>(null);

  // Live account lockout countdown timer & expired badge state
  const [lockoutSeconds, setLockoutSeconds] = useState<number | null>(null);
  const [lockoutExpired, setLockoutExpired] = useState(false);

  useEffect(() => {
    const activeErr = error || authError || "";
    const isFullLockout = (activeErr.includes("temporarily locked") || activeErr.includes("account locked")) && !activeErr.includes("remaining before");
    if (isFullLockout) {
      const secsMatch = activeErr.match(/in (\d+) second\(s\)/i);
      const minsMatch = activeErr.match(/in (\d+) minute\(s\)/i);
      let totalSecs = 0;
      if (secsMatch) {
        totalSecs = parseInt(secsMatch[1], 10);
      } else if (minsMatch) {
        totalSecs = parseInt(minsMatch[1], 10) * 60;
      } else {
        totalSecs = 900;
      }
      setLockoutSeconds(totalSecs);
      setLockoutExpired(false);
    } else {
      setLockoutSeconds(null);
    }
  }, [error, authError]);

  useEffect(() => {
    if (lockoutSeconds === null || lockoutSeconds <= 0) return;

    const interval = setInterval(() => {
      setLockoutSeconds((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          setLockoutExpired(true);
          setError("");
          clearAuthError();
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [lockoutSeconds]);

  const formatLockoutTimer = (totalSecs: number) => {
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  useEffect(() => {
    if (subdomainGate !== "pending") return;
    let cancelled = false;
    (async () => {
      try {
        const response = await apiRequest<{ valid: boolean }>(`/auth/workspace/validate?slug=${encodeURIComponent(subdomainRealm!)}`);
        if (cancelled) return;
        if (response.valid) {
          setSubdomainGate("ok");
        } else {
          setSubdomainError("This workspace doesn't exist. Double-check the link your admin sent you.");
          setSubdomainGate("blocked");
        }
      } catch {
        if (cancelled) return;
        setSubdomainError("Couldn't verify this workspace. Check your connection and try again.");
        setSubdomainGate("blocked");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subdomainGate]);

  // Theme — dark by default, persisted per device.
  const [dark, setDark] = useState(() => localStorage.getItem("frs_theme") !== "light");
  const toggleTheme = () => {
    setDark((d) => {
      const next = !d;
      localStorage.setItem("frs_theme", next ? "dark" : "light");
      return next;
    });
  };

  // Forgot password states
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [resetError, setResetError] = useState("");

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetEmail) return;
    setIsSaving(true);
    setResetError("");
    try {
      await apiRequest('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({
          email: resetEmail
        })
      });

      setResetSent(true);
    }
    catch (err) {
      setResetError(err instanceof ApiError ? err.message : "Failed to send reset link");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setFieldErrors({});
    clearAuthError();

    let hasFieldErrors = false;
    const newFieldErrors: { email?: string; password?: string; workspace?: string } = {};

    if (authConfig.mode === "keycloak") {
      if (phase === "workspace") {
        // Phase 1: validate the workspace slug then show credentials form
        const effectiveRealm = subdomainRealm || workspaceSlug.trim();
        if (!effectiveRealm) {
          setFieldErrors({ workspace: "Workspace/Realm Slug is required." });
          return;
        }
        setIsValidating(true);
        try {
          const response = await apiRequest<{ valid: boolean }>(`/auth/workspace/validate?slug=${encodeURIComponent(effectiveRealm)}`);
          if (!response.valid) {
            setError("The workspace name entered does not exist. Please check your spelling and try again.");
            return;
          }
          localStorage.setItem("frs_current_realm", effectiveRealm);
          setResolvedRealm(effectiveRealm);
          setPhase("credentials");
        } catch {
          setError("An error occurred while validating the workspace. Please try again.");
        } finally {
          setIsValidating(false);
        }
        return;
      }

      // Phase 2: ROPC login with collected credentials
      if (!email || !password) {
        if (!email) {
          newFieldErrors.email = "Email is required.";
          hasFieldErrors = true;
        }
        if (!password) {
          newFieldErrors.password = "Password is required.";
          hasFieldErrors = true;
        }
        if (hasFieldErrors) {
          setFieldErrors(newFieldErrors);
          return;
        }
      }
      setIsValidating(true);
      try {
        const resp = await apiRequest<{ access_token: string; refresh_token: string }>('/auth/keycloak-login', {
          method: 'POST',
          body: JSON.stringify({ username: email.trim(), password, realm: resolvedRealm }),
        });
        if (rememberDevice) {
          localStorage.setItem("frs_remembered_email", email.trim());
        } else {
          localStorage.removeItem("frs_remembered_email");
        }
        const ok = await loginWithKeycloakToken(resp.access_token, resp.refresh_token);
        if (!ok) setError("Login failed. Please try again.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid email or password";
        setError(
          err instanceof ApiError
            ? withRemainingAttemptsHint(message, err.remainingAttempts)
            : message
        );
      } finally {
        setIsValidating(false);
      }
      return;
    }

    if (!email || !password) {
      if (!email) {
        newFieldErrors.email = "Email is required.";
        hasFieldErrors = true;
      }
      if (!password) {
        newFieldErrors.password = "Password is required.";
        hasFieldErrors = true;
      }
      if (hasFieldErrors) {
        setFieldErrors(newFieldErrors);
        return;
      }
    }

    // Remember-this-device: persist the email for prefill next time (never the
    // password). Cleared when the box is unchecked.
    if (rememberDevice) {
      localStorage.setItem("frs_remembered_email", email.trim());
    } else {
      localStorage.removeItem("frs_remembered_email");
    }

    try {

      // S-02: Call login API directly first to detect MFA requirement
      const resp = await apiRequest<{ mfaRequired?: boolean; mfaChallengeToken?: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (resp.mfaRequired && resp.mfaChallengeToken) {
        // MFA required — show verify page; session cookies not set yet
        setMfaChallengeToken(resp.mfaChallengeToken);
        return;
      }

      // Non-MFA path: cookies already set by server, now call login() to bootstrap session
      const success = await login(email, password);
      if (!success) {
        setError("Invalid email address or password.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Invalid email address or password.");
    }
  };

  // Called when MFA verification succeeds — cookies are now set, reload to bootstrap session
  const handleMfaSuccess = () => {
    window.location.reload();
  };

  // S-02: Show MFA verify screen when challenge token is present
  if (mfaChallengeToken) {
    return (
      <MfaVerifyPage
        mfaChallengeToken={mfaChallengeToken}
        onSuccess={handleMfaSuccess}
        onCancel={() => setMfaChallengeToken(null)}
      />
    );
  }

  const busy = isAuthLoading || isValidating;

  // Theme tokens — orange accent, dark default + light variant.
  const t = dark
    ? {
        page: "bg-[#04070F] text-slate-50",
        blob1: "bg-orange-600/20", blob2: "bg-amber-600/15", blob3: "bg-orange-500/10",
        gridOpacity: "opacity-[0.07]",
        card: "border-white/10 bg-white/[0.04] shadow-[0_24px_80px_-20px_rgba(0,0,0,0.7)]",
        title: "text-white", sub: "text-slate-400", label: "text-slate-400",
        input: "border-white/10 bg-black/20 text-white placeholder:text-slate-600",
        icon: "text-slate-500", divider: "border-white/5",
        trust: "text-slate-500", trustIcon: "text-slate-600",
        feature: "border-white/5 bg-white/[0.03] hover:border-white/10 hover:bg-white/[0.05]",
        featureDesc: "text-slate-500", stat: "text-slate-500",
        ghostBtn: "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white",
        footer: "text-slate-600", logo: "",
        chip: "border-orange-500/25 bg-orange-500/[0.07]",
        accentText: "text-orange-300",
        accentTile: "from-orange-500/20 to-amber-500/10 ring-orange-500/25",
        accentIcon: "text-orange-300",
        badge: "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20",
        errBox: "border-red-500/20 bg-red-500/10 text-red-400",
        focus: "focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30",
      }
    : {
        page: "bg-[#F4F6FB] text-slate-900",
        blob1: "bg-orange-400/25", blob2: "bg-amber-300/25", blob3: "bg-orange-300/20",
        gridOpacity: "opacity-[0.5]",
        card: "border-slate-200 bg-white/80 shadow-[0_24px_80px_-28px_rgba(15,23,42,0.25)]",
        title: "text-slate-900", sub: "text-slate-500", label: "text-slate-500",
        input: "border-slate-200 bg-white text-slate-900 placeholder:text-slate-400",
        icon: "text-slate-400", divider: "border-slate-200",
        trust: "text-slate-500", trustIcon: "text-slate-400",
        feature: "border-slate-200 bg-white/70 hover:border-slate-300 hover:bg-white",
        featureDesc: "text-slate-500", stat: "text-slate-500",
        ghostBtn: "border-slate-200 bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-900",
        footer: "text-slate-400", logo: "",
        chip: "border-orange-300 bg-orange-50",
        accentText: "text-orange-600",
        accentTile: "from-orange-100 to-amber-100 ring-orange-200",
        accentIcon: "text-orange-600",
        badge: "bg-emerald-50 text-emerald-600 ring-emerald-200",
        errBox: "border-red-200 bg-red-50 text-red-600",
        focus: "focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30",
      };

  return (
    <div className={`relative min-h-screen overflow-hidden font-sans transition-colors duration-300 ${t.page}`}>
      <style>{`
        @keyframes frs-float { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(20px,-30px) scale(1.08)} }
        @keyframes frs-float-slow { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(-30px,25px) scale(1.12)} }
        @keyframes frs-rise { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
        .frs-rise{animation:frs-rise .55s cubic-bezier(.16,1,.3,1) both}
      `}</style>

      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div
          className={`absolute inset-0 ${t.gridOpacity}`}
          style={{
            backgroundImage:
              "linear-gradient(rgba(148,163,184,.5) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.5) 1px,transparent 1px)",
            backgroundSize: "64px 64px",
            maskImage: "radial-gradient(ellipse 80% 60% at 30% 0%, #000 40%, transparent 100%)",
          }}
        />
        <div className={`absolute -top-40 -left-32 h-[34rem] w-[34rem] rounded-full blur-[140px] ${t.blob1}`} style={{ animation: "frs-float 14s ease-in-out infinite" }} />
        <div className={`absolute top-1/3 -right-40 h-[32rem] w-[32rem] rounded-full blur-[150px] ${t.blob2}`} style={{ animation: "frs-float-slow 18s ease-in-out infinite" }} />
        <div className={`absolute -bottom-44 left-1/3 h-[28rem] w-[28rem] rounded-full blur-[150px] ${t.blob3}`} style={{ animation: "frs-float 20s ease-in-out infinite" }} />
      </div>

      {/* Top bar */}
      <header className="absolute top-0 z-20 flex w-full items-center justify-between px-6 py-5 lg:px-10">
        <div className="flex items-center">
          <img src="/motivity-logo.png" alt="Motivity Labs" className={`h-8 w-auto object-contain block ${t.logo}`} />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className={`flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition-colors ${t.ghostBtn}`}
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <a
            href="mailto:support@motivitylabs.com"
            className={`hidden rounded-full border px-4 py-2 text-xs font-semibold backdrop-blur transition-colors sm:block ${t.ghostBtn}`}
          >
            Need help?
          </a>
        </div>
      </header>

      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col items-stretch gap-8 px-6 pb-8 pt-20 lg:flex-row lg:items-center lg:gap-14 lg:px-10">

        {/* Left — Branding */}
        <div className="frs-rise flex-1 lg:pr-4">
          <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ${t.chip}`}>
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-orange-500" />
            </span>
            <span className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${t.accentText}`}>AI Engine Active</span>
          </div>

          <h1 className={`mt-6 text-4xl font-black leading-[0.95] tracking-tight sm:text-5xl xl:text-6xl ${t.title}`}>
            Motivity
            <span className="block bg-gradient-to-r from-orange-500 via-amber-500 to-orange-400 bg-clip-text italic text-transparent">
              FRS
            </span>
          </h1>

          <p className={`mt-5 max-w-md text-sm leading-relaxed lg:text-base ${t.sub}`}>
            Enterprise-grade attendance intelligence powered by advanced facial recognition —
            identify, verify, and monitor your workforce with zero friction.
          </p>


        </div>

        {/* Right — Login card */}
        <div className="frs-rise w-full lg:w-[420px] lg:shrink-0" style={{ animationDelay: ".08s" }}>
          <div className={`rounded-3xl border p-6 backdrop-blur-2xl sm:p-7 ${t.card}`}>
            <div className="mb-6">
              <h2 className={`text-2xl font-bold tracking-tight ${t.title}`}>Welcome back</h2>
              <p className={`mt-1.5 text-sm ${t.sub}`}>Sign in to your MotivityFRS workspace.</p>
            </div>

            {subdomainGate === "pending" && (
              <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                <Loader2 className={`h-6 w-6 animate-spin ${t.accentText}`} />
                <p className={`text-sm font-medium ${t.sub}`}>Checking workspace…</p>
              </div>
            )}

            {subdomainGate === "blocked" && (
              <div className="space-y-4">
                <div className={`flex items-start gap-2.5 rounded-2xl border p-3.5 text-sm font-medium ${t.errBox}`}>
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                  <span>{subdomainError}</span>
                </div>
                <Button
                  type="button"
                  onClick={() => { setSubdomainError(null); setSubdomainGate("pending"); }}
                  className="h-12 w-full rounded-2xl bg-gradient-to-r from-orange-500 to-amber-500 text-base font-bold tracking-wide text-white shadow-[0_8px_30px_-6px_rgba(249,115,22,0.55)] transition-all hover:from-orange-400 hover:to-amber-400"
                >
                  Try again
                </Button>
              </div>
            )}

            {subdomainGate === "ok" && (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Keycloak Phase 1: workspace slug */}
              {authConfig.mode === "keycloak" && phase === "workspace" && !subdomainRealm && (
                <div className="space-y-2">
                  <Label htmlFor="workspaceSlug" className={`text-[11px] font-bold uppercase tracking-[0.14em] ${fieldErrors.workspace ? 'text-red-500' : t.label}`}>
                    WORKSPACE
                  </Label>
                  <div className="relative">
                    <Globe className={`pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 ${fieldErrors.workspace ? 'text-red-500' : t.icon}`} />
                    <Input
                      id="workspaceSlug"
                      type="text"
                      placeholder="e.g. motivity"
                      value={workspaceSlug}
                      onChange={(e) => {
                        setWorkspaceSlug(e.target.value.replace(/\s+/g, ''));
                        if (fieldErrors.workspace) setFieldErrors(prev => ({ ...prev, workspace: undefined }));
                      }}
                      onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                      className={`h-12 rounded-2xl pl-12 pr-4 font-medium transition-all ${t.input} ${fieldErrors.workspace ? 'border-red-500 ring-2 ring-red-500/30' : t.focus}`}
                    />
                  </div>
                  {fieldErrors.workspace && (
                    <p className="text-xs text-red-500 font-medium flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5" />{fieldErrors.workspace}</p>
                  )}
                  <p className={`text-xs ${t.featureDesc}`}>
                    On your tenant URL (e.g. <span className={t.sub}>acme.frs.motivitylabs.com</span>) this is detected automatically.
                  </p>
                </div>
              )}

              {/* Keycloak Phase 2: email + password after workspace confirmed */}
              {authConfig.mode === "keycloak" && phase === "credentials" && (
                <>
                  {/* Workspace badge */}
                  <div className={`flex items-center gap-3 rounded-2xl border px-3.5 py-3 ${t.chip}`}>
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ring-1 ${t.accentTile}`}>
                      <Globe className={`h-5 w-5 ${t.accentIcon}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={`truncate font-semibold capitalize ${t.title}`}>{resolvedRealm}</div>
                      <div className={`truncate text-xs ${t.featureDesc}`}>{window.location.hostname}</div>
                    </div>
                    <button
                      type="button"
                      className={`text-xs font-semibold ${t.accentText} hover:opacity-80`}
                      onClick={() => { setPhase("workspace"); setError(""); clearAuthError(); }}
                    >
                      Change
                    </button>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="email" className={`text-[11px] font-bold uppercase tracking-[0.14em] ${fieldErrors.email ? 'text-red-500' : t.label}`}>Work Email</Label>
                    <div className="relative">
                      <Mail className={`pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 ${fieldErrors.email ? 'text-red-500' : t.icon}`} />
                      <Input
                        id="email"
                        type="email"
                        placeholder="you@company.com"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value.replace(/\s+/g, ''));
                          if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: undefined }));
                        }}
                        onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                        autoFocus
                        className={`h-12 rounded-2xl pl-12 pr-4 font-medium transition-all ${t.input} ${fieldErrors.email ? 'border-red-500 ring-2 ring-red-500/30' : t.focus}`}
                      />
                    </div>
                    {fieldErrors.email && (
                      <p className="text-xs text-red-500 font-medium flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5" />{fieldErrors.email}</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="password" className={`text-[11px] font-bold uppercase tracking-[0.14em] ${fieldErrors.password ? 'text-red-500' : t.label}`}>Password</Label>
                      <button
                        type="button"
                        onClick={() => setIsResetOpen(true)}
                        className={`text-xs font-bold transition-colors ${t.accentText} hover:opacity-80`}
                      >
                        Forgot password?
                      </button>
                    </div>
                    <div className="relative">
                      <Lock className={`pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 ${fieldErrors.password ? 'text-red-500' : t.icon}`} />
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        placeholder="Enter your password"
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          if (fieldErrors.password) setFieldErrors(prev => ({ ...prev, password: undefined }));
                        }}
                        onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                        className={`h-12 rounded-2xl pl-12 pr-12 font-medium transition-all [&::-ms-reveal]:hidden [&::-webkit-reveal]:hidden ${t.input} ${fieldErrors.password ? 'border-red-500 ring-2 ring-red-500/30' : t.focus}`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className={`absolute right-4 top-1/2 -translate-y-1/2 transition-colors ${t.icon} hover:opacity-80`}
                      >
                        {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                      </button>
                    </div>
                    {fieldErrors.password && (
                      <p className="text-xs text-red-500 font-medium flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5" />{fieldErrors.password}</p>
                    )}
                  </div>

                  <label htmlFor="remember" className={`flex cursor-pointer items-center gap-3 pt-0.5 text-sm font-medium ${t.sub}`}>
                    <Checkbox
                      id="remember"
                      checked={rememberDevice}
                      onCheckedChange={(checked) => setRememberDevice(checked === true)}
                      className="h-5 w-5 rounded-md border-slate-400/40 data-[state=checked]:border-orange-600 data-[state=checked]:bg-orange-600"
                    />
                    Remember my email on this device
                  </label>
                </>
              )}

              {authConfig.mode !== "keycloak" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="email" className={`text-[11px] font-bold uppercase tracking-[0.14em] ${fieldErrors.email ? 'text-red-500' : t.label}`}>Work Email</Label>
                    <div className="relative">
                      <Mail className={`pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 ${fieldErrors.email ? 'text-red-500' : t.icon}`} />
                      <Input
                        id="email"
                        type="email"
                        placeholder="you@company.com"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value.replace(/\s+/g, ''));
                          if (fieldErrors.email) setFieldErrors(prev => ({ ...prev, email: undefined }));
                        }}
                        onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                        className={`h-12 rounded-2xl pl-12 pr-4 font-medium transition-all ${t.input} ${fieldErrors.email ? 'border-red-500 ring-2 ring-red-500/30' : t.focus}`}
                      />
                    </div>
                    {fieldErrors.email && (
                      <p className="text-xs text-red-500 font-medium flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5" />{fieldErrors.email}</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="password" className={`text-[11px] font-bold uppercase tracking-[0.14em] ${fieldErrors.password ? 'text-red-500' : t.label}`}>Password</Label>
                      <button
                        type="button"
                        onClick={() => setIsResetOpen(true)}
                        className={`text-xs font-bold transition-colors ${t.accentText} hover:opacity-80`}
                      >
                        Forgot password?
                      </button>
                    </div>
                    <div className="relative">
                      <Lock className={`pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 ${fieldErrors.password ? 'text-red-500' : t.icon}`} />
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        placeholder="Enter your password"
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          if (fieldErrors.password) setFieldErrors(prev => ({ ...prev, password: undefined }));
                        }}
                        onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                        className={`h-12 rounded-2xl pl-12 pr-12 font-medium transition-all [&::-ms-reveal]:hidden [&::-webkit-reveal]:hidden ${t.input} ${fieldErrors.password ? 'border-red-500 ring-2 ring-red-500/30' : t.focus}`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className={`absolute right-4 top-1/2 -translate-y-1/2 transition-colors ${t.icon} hover:opacity-80`}
                      >
                        {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                      </button>
                    </div>
                    {fieldErrors.password && (
                      <p className="text-xs text-red-500 font-medium flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5" />{fieldErrors.password}</p>
                    )}
                  </div>

                  <label htmlFor="remember" className={`flex cursor-pointer items-center gap-3 pt-0.5 text-sm font-medium ${t.sub}`}>
                    <Checkbox
                      id="remember"
                      checked={rememberDevice}
                      onCheckedChange={(checked) => setRememberDevice(checked === true)}
                      className="h-5 w-5 rounded-md border-slate-400/40 data-[state=checked]:border-orange-600 data-[state=checked]:bg-orange-600"
                    />
                    Remember my email on this device
                  </label>
                </>
              )}

              {lockoutExpired && (
                <div className="flex items-center gap-2.5 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-sm font-semibold text-emerald-600 dark:text-emerald-400 shadow-sm animate-fade-in">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                  <span>Lockout expired. You can try signing in again now.</span>
                </div>
              )}

              {lockoutSeconds !== null && lockoutSeconds > 0 && (
                <div className="flex items-start gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm font-medium text-rose-600 dark:text-rose-400 shadow-sm">
                  <Clock className="mt-0.5 h-5 w-5 shrink-0 text-rose-500 animate-spin-slow" />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-rose-700 dark:text-rose-300">Account Temporarily Locked</span>
                      <span className="font-mono text-xs font-bold px-2.5 py-1 rounded-md bg-rose-500/20 text-rose-700 dark:text-rose-300 border border-rose-500/30">
                        {formatLockoutTimer(lockoutSeconds)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-rose-800 dark:text-rose-200">
                      Too many failed login attempts. Please wait until the lockout timer expires before attempting sign in.
                    </p>
                  </div>
                </div>
              )}

              {lockoutSeconds === null && !lockoutExpired && (error || authError) && (
                (error || authError)?.includes("remaining before") ? (
                  <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-sm font-medium text-amber-800 dark:text-amber-200 shadow-sm">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500 animate-pulse" />
                    <div className="flex-1">
                      <p className="font-bold text-amber-900 dark:text-amber-100">Security Warning</p>
                      <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-200">{error || authError}</p>
                    </div>
                  </div>
                ) : (
                  <div className={`flex items-start gap-2.5 rounded-2xl border p-3.5 text-sm font-medium ${t.errBox}`}>
                    <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                    <span>{error || authError}</span>
                  </div>
                )
              )}

              <Button
                type="submit"
                disabled={busy}
                className="group relative h-12 w-full overflow-hidden rounded-2xl bg-gradient-to-r from-orange-500 to-amber-500 text-base font-bold tracking-wide text-white shadow-[0_8px_30px_-6px_rgba(249,115,22,0.55)] transition-all hover:from-orange-400 hover:to-amber-400 hover:shadow-[0_10px_40px_-6px_rgba(249,115,22,0.75)] disabled:opacity-70"
              >
                <span className="flex items-center justify-center gap-2">
                  {busy && <Loader2 className="h-5 w-5 animate-spin" />}
                  {authConfig.mode === "keycloak"
                    ? (isValidating
                        ? (phase === "workspace" ? "Checking workspace…" : "Signing in…")
                        : (phase === "workspace" ? "Continue" : "Sign in"))
                    : (isAuthLoading ? "Signing in…" : "Sign in")}
                  {!busy && <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-0.5" />}
                </span>
              </Button>
            </form>
            )}

            <div className={`mt-5 flex items-center justify-center gap-5 border-t pt-4 text-[11px] font-medium ${t.divider} ${t.trust}`}>
              <span className="inline-flex items-center gap-1.5"><ShieldCheck className={`h-3.5 w-3.5 ${t.trustIcon}`} /> 256-bit TLS</span>
              <span className="inline-flex items-center gap-1.5"><Fingerprint className={`h-3.5 w-3.5 ${t.trustIcon}`} /> Biometric</span>
              <span className="inline-flex items-center gap-1.5"><Sparkles className={`h-3.5 w-3.5 ${t.trustIcon}`} /> SSO ready</span>
            </div>
          </div>

          <p className={`mt-5 text-center text-xs ${t.footer}`}>
            © {new Date().getFullYear()} Motivity Labs. All rights reserved.
          </p>
        </div>
      </div>

      {/* Forgot Password Dialog */}
      <Dialog open={isResetOpen} onOpenChange={(open) => { setIsResetOpen(open); if (!open) { setResetError(""); setResetEmail(""); setResetSent(false); } }}>
        <DialogContent className={`rounded-3xl border backdrop-blur-2xl sm:max-w-md ${dark ? "border-white/10 bg-[#0B111D]/95 text-white" : "border-slate-200 bg-white text-slate-900"}`}>
          <DialogHeader>
            <DialogTitle className={`text-xl font-bold ${t.title}`}>Reset password</DialogTitle>
            <DialogDescription className={`text-sm ${t.sub}`}>
              Enter your work email address and we'll send you a secure password reset link.
            </DialogDescription>
          </DialogHeader>
          {resetSent ? (
            <div className="space-y-4 py-4 text-center">
              <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br ring-1 ${t.accentTile}`}>
                <Mail className={`h-7 w-7 ${t.accentIcon}`} />
              </div>
              <p className={`text-sm font-semibold ${t.title}`}>Reset link sent!</p>
              <p className={`text-xs ${t.sub}`}>
                Check your email <strong className={t.title}>{resetEmail}</strong> for a link to reset your password.
              </p>
              <Button onClick={() => { setIsResetOpen(false); setResetSent(false); setResetEmail(""); setResetError(""); }} className="h-11 w-full rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white hover:from-orange-400 hover:to-amber-400">
                Close
              </Button>
            </div>
          ) : (
            <form onSubmit={handleResetSubmit} className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label className={t.label}>Email address</Label>
                <div className="relative">
                  <Mail className={`pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 ${t.icon}`} />
                  <Input
                    type="email"
                    placeholder="you@company.com"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value.replace(/\s+/g, ''))}
                    onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                    className={`h-12 rounded-2xl pl-12 pr-4 ${t.input} ${t.focus}`}
                    required
                  />
                </div>
              </div>

              {resetError && (
                <div className={`flex items-center gap-2 rounded-xl border p-3 text-xs font-medium ${t.errBox}`}>
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{resetError}</span>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" type="button" onClick={() => setIsResetOpen(false)} className={`rounded-xl ${t.ghostBtn}`}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSaving} className="h-11 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 px-5 font-bold text-white hover:from-orange-400 hover:to-amber-400">
                  {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Send reset link
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
