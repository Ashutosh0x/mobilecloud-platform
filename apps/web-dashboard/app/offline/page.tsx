import Link from "next/link";

export const metadata = { title: "Offline — FurlPay" };

export default function OfflinePage() {
  return (
    <main className="auth">
      <div className="panel auth-card">
        <h1>Offline</h1>
        <p className="sub">
          This page was not cached. Sign-in, payments and account changes require a live connection and are never served from
          the offline cache.
        </p>
        <Link className="primary auth-link" href="/">
          Try again
        </Link>
      </div>
    </main>
  );
}
