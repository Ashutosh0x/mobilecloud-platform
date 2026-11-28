import {
  Bell,
  ChartLineUp,
  Cloud,
  CreditCard,
  Cube,
  Database,
  DeviceMobile,
  Fingerprint,
  Folder,
  Gear,
  GitBranch,
  GithubLogo,
  Globe,
  House,
  Lightning,
  MagnifyingGlass,
  Moon,
  Pulse,
  RocketLaunch,
  ShieldCheck,
  SquaresFour,
  Sun,
  TerminalWindow,
  User,
  Users,
  type IconWeight,
} from "@phosphor-icons/react";

/**
 * The console's icon set.
 *
 * Every glyph is an official Phosphor icon — one family, six weights, one
 * drawing style — so the navigation, the buttons and the status rows all
 * read as the same system instead of a collection of hand-drawn paths.
 *
 * The component keeps the small `name` API the rest of the console already
 * uses, and maps each name to its Phosphor counterpart. A name that is not
 * in the map renders nothing rather than a placeholder shape: an unknown
 * icon is a bug to fix, not a gap to paper over.
 */
export function Icon({ name, size = 16, weight = "regular" }: { name: string; size?: number; weight?: IconWeight }) {
  const shared = { size, weight, "aria-hidden": true } as const;
  switch (name) {
    case "cloud":
      return <Cloud {...shared} />;
    case "search":
      return <MagnifyingGlass {...shared} />;
    case "bell":
      return <Bell {...shared} />;
    case "home":
      return <House {...shared} />;
    case "folder":
      return <Folder {...shared} />;
    case "rocket":
      return <RocketLaunch {...shared} />;
    case "globe":
      return <Globe {...shared} />;
    case "db":
      return <Database {...shared} />;
    case "zap":
      return <Lightning {...shared} />;
    case "box":
      return <Cube {...shared} />;
    case "activity":
      return <Pulse {...shared} />;
    case "logs":
      return <TerminalWindow {...shared} />;
    case "gear":
      return <Gear {...shared} />;
    case "user":
      return <User {...shared} />;
    case "users":
      return <Users {...shared} />;
    case "card":
      return <CreditCard {...shared} />;
    case "android":
      return <DeviceMobile {...shared} />;
    case "chart":
      return <ChartLineUp {...shared} />;
    case "shield":
      return <ShieldCheck {...shared} />;
    case "passkey":
      return <Fingerprint {...shared} />;
    case "grid":
      return <SquaresFour {...shared} />;
    case "github":
      return <GithubLogo {...shared} />;
    case "branch":
      return <GitBranch {...shared} />;
    case "sun":
      return <Sun {...shared} />;
    case "moon":
      return <Moon {...shared} />;
    default:
      return null;
  }
}
