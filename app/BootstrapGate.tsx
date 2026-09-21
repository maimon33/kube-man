"use client";

import { type FormEvent, useEffect, useState } from "react";
import ConsoleApp from "./ConsoleApp";

import { type User } from "./api";

type BootstrapStatus = {
  initialized: boolean;
  builtInGoogleAvailable?: boolean;
  adminEmail?: string;
  googleMode?: "custom" | "builtin";
  configuredAt?: string;
};
type SessionStatus = { authenticated: boolean; user?: User };

// The identity service is served by the gateway on this same origin.
const bootstrapUrl = (path: string) => path;

export default function BootstrapGate() {
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [loadError, setLoadError] = useState(false);

  function loadStatus() {
    setLoadError(false);
    fetch(bootstrapUrl("/status"))
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((next: BootstrapStatus) => setStatus(next))
      .catch(() => setLoadError(true));
  }

  useEffect(loadStatus, []);
  useEffect(() => {
    if (!status?.initialized) return;
    fetch(bootstrapUrl("/session"), { credentials: "include" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((next: SessionStatus) => setSession(next))
      .catch(() => setLoadError(true));
  }, [status?.initialized]);

  if (loadError) return <BootstrapUnavailable retry={loadStatus} />;
  if (!status) return <div className="bootstrap-loading"><div className="brand-mark">KM</div><span>Checking system state…</span></div>;
  if (!status.initialized) return <BootstrapSetup builtInGoogleAvailable={Boolean(status.builtInGoogleAvailable)} complete={setStatus} />;
  if (!session) return <div className="bootstrap-loading"><div className="brand-mark">KM</div><span>Checking your Google session…</span></div>;
  if (!session.authenticated || !session.user) return <GoogleSignIn adminEmail={status.adminEmail || ""} />;
  return <ConsoleApp user={session.user} />;
}

function BootstrapSetup({ builtInGoogleAvailable, complete }: { builtInGoogleAvailable: boolean; complete: (status: BootstrapStatus) => void }) {
  const [googleMode, setGoogleMode] = useState<"custom" | "builtin">(builtInGoogleAvailable ? "builtin" : "custom");
  const [guideOpen, setGuideOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Only rendered after the client-side status fetch, so window is available.
  const [redirectUri] = useState(() => `${window.location.origin}/auth/google/callback`);

  useEffect(() => {
    if (!guideOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && setGuideOpen(false);
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [guideOpen]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      const response = await fetch(bootstrapUrl("/initialize"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startupCode: form.get("startupCode"), adminEmail: form.get("adminEmail"), googleMode,
          googleClientId: form.get("googleClientId"), googleClientSecret: form.get("googleClientSecret"),
          allowedDomain: form.get("allowedDomain"),
        }),
      });
      const result = await response.json() as BootstrapStatus & { error?: string };
      if (!response.ok) throw new Error(result.error || "Setup could not be completed");
      complete(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Setup could not be completed");
      setBusy(false);
    }
  }

  return <><main className="bootstrap-page">
    <section className="bootstrap-intro">
      <div className="bootstrap-brand"><div className="brand-mark">KM</div><strong>KubeMan</strong></div>
      <div className="bootstrap-copy"><span>First-run setup</span><h1>Secure the control plane before connecting your clusters.</h1><p>A one-time startup code proves you have access to the machine running KubeMan. Then configure Google sign-in and establish the first administrator.</p></div>
      <div className="bootstrap-assurances"><div><i>1</i><span><strong>Local possession check</strong><small>The startup code is generated inside Docker and expires permanently after setup.</small></span></div><div><i>2</i><span><strong>Google email identity</strong><small>Google passes a verified email to KubeMan so it can match and authenticate users.</small></span></div><div><i>3</i><span><strong>First administrator</strong><small>The initial email becomes the system owner and can invite other users and manage roles.</small></span></div></div>
      <small className="bootstrap-local">Setup is protected by the one-time startup code</small>
    </section>
    <section className="bootstrap-panel">
      <div className="setup-heading"><span>System initialization</span><h2>Set up KubeMan</h2><p>Complete these settings once. They are retained in a dedicated protected Docker volume.</p></div>
      <form onSubmit={submit} className="setup-form">
        <fieldset><legend><b>1</b><span>Startup code<small>Retrieve it from the bootstrap service logs on the machine running KubeMan.</small></span></legend><label><span>One-time code</span><input name="startupCode" required autoComplete="one-time-code" placeholder="KMAN-XXXXX-XXXXX-XXXXX-XXXXX" spellCheck={false}/></label><code>docker compose logs kubeman-bootstrap</code></fieldset>
        <fieldset><legend><b>2</b><span>Google application<small>Passes verified email identity to KubeMan for authentication and user matching.</small></span></legend><div className="google-guide-bar"><div><strong>Why is a Google app needed?</strong><span>It lets Google return a verified email address that KubeMan matches to an allowed user.</span></div><button type="button" onClick={() => setGuideOpen(true)}>Open simple setup guide</button></div><div className="setup-choice"><button type="button" className={googleMode === "custom" ? "active" : ""} onClick={() => setGoogleMode("custom")}><strong>Create or use a Google app</strong><small>Enter OAuth credentials from Google Cloud.</small></button><button type="button" disabled={!builtInGoogleAvailable} className={googleMode === "builtin" ? "active production" : "production"} onClick={() => setGoogleMode("builtin")}><strong>Use the public KubeMan Google app</strong><small>{builtInGoogleAvailable ? "Ready — created for this open-source project." : "Available after its credentials are supplied locally."}</small></button></div>{googleMode === "custom" && <div className="setup-fields"><label><span>OAuth client ID</span><input name="googleClientId" required placeholder="…apps.googleusercontent.com" autoComplete="off"/></label><label><span>OAuth client secret</span><input name="googleClientSecret" required type="password" autoComplete="new-password"/></label></div>}<label><span>Allowed email domain <em>optional</em></span><input name="allowedDomain" placeholder="company.com" autoComplete="off"/></label><p className="redirect-hint">Authorized redirect URI: <strong>{redirectUri}</strong>{!redirectUri.startsWith("https://") && !redirectUri.startsWith("http://localhost") && <> — Google only accepts <em>https</em> (or localhost) redirect URIs, so serve KubeMan over HTTPS.</>}</p></fieldset>
        <fieldset><legend><b>3</b><span>Initial administrator<small>This account receives full system access.</small></span></legend><label><span>Admin email</span><input name="adminEmail" required type="email" placeholder="admin@company.com" autoComplete="email"/></label></fieldset>
        {error && <div className="setup-error">{error}</div>}
        <button className="setup-submit" type="submit" disabled={busy}>{busy ? "Initializing system…" : "Initialize KubeMan"}</button>
      </form>
    </section>
  </main>{guideOpen && <GoogleSetupGuide redirectUri={redirectUri} productionAvailable={builtInGoogleAvailable} chooseProduction={() => { setGoogleMode("builtin"); setGuideOpen(false); }} close={() => setGuideOpen(false)} />}</>;
}

function GoogleSetupGuide({ redirectUri, productionAvailable, chooseProduction, close }: { redirectUri: string; productionAvailable: boolean; chooseProduction: () => void; close: () => void }) {
  return <div className="guide-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><section className="google-guide" role="dialog" aria-modal="true" aria-labelledby="google-guide-title"><header><div><span>Google sign-in</span><h2 id="google-guide-title">Simple Google app setup</h2><p>The Google app is used only to pass a verified email identity to KubeMan. KubeMan matches that email to its user records and authenticates the user; it never receives the user’s Google password.</p></div><button onClick={close} aria-label="Close Google setup guide">×</button></header><div className="guide-body"><div className="guide-steps"><article><b>1</b><div><strong>Open Google Auth Platform</strong><p>Create or select a Google Cloud project, then start the Google Auth Platform setup.</p><a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Open Google Cloud ↗</a></div></article><article><b>2</b><div><strong>Set branding and audience</strong><p>Name the app “KubeMan”, add a support email, and choose Internal for one Google Workspace organization or External for other Google accounts. If the app is in testing, add the admin email as a test user.</p></div></article><article><b>3</b><div><strong>Create a web OAuth client</strong><p>Open Clients, choose Create client, and select <em>Web application</em>. Google will issue a client ID and client secret.</p></div></article><article><b>4</b><div><strong>Add the exact redirect URI</strong><p>Under Authorized redirect URIs, add:</p><code>{redirectUri}</code><small>The value must match exactly, including scheme, port and path. Use the address people open KubeMan with; Google requires https unless it is localhost.</small></div></article><article><b>5</b><div><strong>Copy the credentials here</strong><p>Copy the client ID and secret immediately. Google may show the client secret only when the client is created.</p></div></article></div><aside><span className="production-badge">Fastest option</span><h3>Use the public KubeMan Google app</h3><p>This Google app was created for the KubeMan open-source project. It requests only the identity needed to pass a verified email to KubeMan for user matching and authentication.</p>{productionAvailable ? <button onClick={chooseProduction}>Use public KubeMan app</button> : <><button disabled>Public app not configured locally</button><small>Supply <code>KUBEMAN_GOOGLE_CLIENT_ID</code> and <code>KUBEMAN_GOOGLE_CLIENT_SECRET</code> through <code>.env</code>, then restart Docker. The values remain outside the browser and repository.</small></>}</aside></div><footer><a href="https://support.google.com/cloud/answer/15544987" target="_blank" rel="noreferrer">Google’s official setup documentation ↗</a><button onClick={close}>Got it</button></footer></section></div>;
}

function BootstrapUnavailable({ retry }: { retry: () => void }) {
  return <div className="bootstrap-unavailable"><div className="brand-mark">KM</div><h1>Bootstrap service is unavailable</h1><p>Make sure the KubeMan services are running (docker compose ps) and that you are opening KubeMan through its gateway address, then try again.</p><button onClick={retry}>Retry connection</button></div>;
}

const SIGN_IN_ERRORS: Record<string, string> = {
  not_allowed: "That Google account has not been added to KubeMan. Ask an administrator to invite you.",
  account_disabled: "This account has been disabled by an administrator.",
  invalid_oauth_response: "The sign-in response could not be verified. Please try again.",
  google_sign_in_failed: "Google sign-in failed. Check the OAuth client settings and the redirect URI, then try again.",
};

function GoogleSignIn({ adminEmail }: { adminEmail: string }) {
  const [failure] = useState(() => {
    const code = new URLSearchParams(window.location.search).get("auth_error");
    return code ? SIGN_IN_ERRORS[code] ?? "Sign-in failed." : "";
  });
  useEffect(() => { if (failure) window.history.replaceState(null, "", "/"); }, [failure]);
  return <main className="signin-page"><section><div className="bootstrap-brand"><div className="brand-mark">KM</div><strong>KubeMan</strong></div><div className="signin-lock">◆</div><span>Protected control plane</span><h1>Sign in to KubeMan</h1><p>Continue with an approved Google account.{adminEmail && <> The initial administrator is <strong>{adminEmail}</strong>.</>}</p>{failure && <div className="setup-error signin-error" role="alert">{failure}</div>}<a href={bootstrapUrl("/auth/google/start")}>Continue with Google</a><small>Authentication is handled by your configured Google OAuth application.</small></section></main>;
}
