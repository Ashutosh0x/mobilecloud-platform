export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "cloud":
      return <svg {...p}><path d="M7 18h10a4 4 0 0 0 .4-8 6 6 0 0 0-11.5-1.5A4.5 4.5 0 0 0 7 18z" /></svg>;
    case "search":
      return <svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
    case "bell":
      return <svg {...p}><path d="M6 9a6 6 0 1 1 12 0c0 7 2 7 2 9H4c0-2 2-2 2-9" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>;
    case "home":
      return <svg {...p}><path d="M4 11.5 12 4l8 7.5" /><path d="M6 10.5V20h12v-9.5" /></svg>;
    case "folder":
      return <svg {...p}><path d="M3 7h6l2 2h10v10H3z" /></svg>;
    case "rocket":
      return <svg {...p}><path d="M14 4c3 1 5 5 5 8-3 0-6-1-8-3" /><path d="M9 10 4 15l5 1 1 5 5-5" /><path d="M14 14l-4-4" /></svg>;
    case "globe":
      return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.8 2.5 15.2 0 18M12 3c-2.5 2.8-2.5 15.2 0 18" /></svg>;
    case "db":
      return <svg {...p}><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></svg>;
    case "zap":
      return <svg {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>;
    case "box":
      return <svg {...p}><path d="M3 8l9-5 9 5-9 5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg>;
    case "activity":
      return <svg {...p}><path d="M3 12h4l2-6 4 12 2-6h6" /></svg>;
    case "logs":
      return <svg {...p}><path d="M8 4h10v16H8z" /><path d="M6 7H5m1 4H5m1 4H5M11 8h5M11 12h5M11 16h4" /></svg>;
    case "gear":
      return <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></svg>;
    case "user":
      return <svg {...p}><circle cx="12" cy="8" r="3.2" /><path d="M5.5 19.2v-.6a4.5 4.5 0 0 1 4.5-4.5h4a4.5 4.5 0 0 1 4.5 4.5v.6" /></svg>;
    case "users":
      return <svg {...p}><path d="M16 19v-1a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v1" /><circle cx="10" cy="8" r="3" /><path d="M20 19v-1a3 3 0 0 0-2.2-2.9M16 5.1a3 3 0 0 1 0 5.8" /></svg>;
    case "card":
      return <svg {...p}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18" /></svg>;
    case "android":
      return <svg {...p}><path d="M7 10h10v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" /><path d="M9 10V8a3 3 0 0 1 6 0v2M8 6 6.5 4.5M16 6l1.5-1.5" /></svg>;
    case "chart":
      return <svg {...p}><path d="M4 19h16M7 16l3-4 3 2 4-6" /></svg>;
    case "shield":
      return <svg {...p}><path d="M12 3 5 6v6c0 4.5 3 6.5 7 8 4-1.5 7-3.5 7-8V6z" /></svg>;
    case "passkey":
      // Fingerprint + key bow: used wherever a WebAuthn/passkey action appears.
      return (
        <svg {...p}>
          <path d="M5.5 12a6.5 6.5 0 0 1 13 0v2" />
          <path d="M8.5 13a3.5 3.5 0 0 1 7 0v3a5.5 5.5 0 0 1-1 3.2" />
          <path d="M12 15.5V19" />
          <circle cx="18.5" cy="16.5" r="1.5" />
          <path d="M17.5 17.5 15 20" />
        </svg>
      );
    case "grid":
      return <svg {...p}><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></svg>;
    default:
      return null;
  }
}
