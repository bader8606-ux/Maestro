import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  Handshake,
  Layers3,
  Users,
  Palette,
  LogOut,
  Plus,
  Search,
  ChevronDown,
  ArrowUpRight,
  ArrowRight,
  Download,
  X,
  Check,
  CheckCircle2,
  Circle,
  CreditCard,
  FileCheck2,
  Wallet,
  TrendingUp,
  Clock3,
  Menu,
  MoreHorizontal,
  Copy,
  Phone,
  Mail,
  MessageCircle,
  Upload,
  FileText,
  Eye,
  Trash2,
  RefreshCw,
  ShieldCheck,
  LockKeyhole,
  ZoomIn,
  ZoomOut,
  SlidersHorizontal,
  Building2,
  AlertCircle,
  LoaderCircle,
  ExternalLink,
  Pencil,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import "./styles.css";
import "./identity.css";
import { originalIdentity } from "./brand";
import { api, request, attachmentUrl, connectionMissing } from "./api";

type User = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "editor" | "viewer";
  active: boolean;
};
type Package = {
  id: string;
  name: string;
  benefits: string[];
  referenceValue?: number;
};
type Attachment = {
  id: string;
  sponsorId: string;
  kind: "approval" | "purchase-order" | "logo";
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  url?: string;
};
type Sponsor = {
  id: string;
  name: string;
  packageId: string;
  packageName: string;
  contact: string;
  mobile: string;
  email: string;
  approval: "Not Approved" | "In Progress" | "Approved";
  approvalDate: string;
  poIssued: boolean;
  poNumber: string;
  poDate: string;
  value: number;
  payments: { id: string; amount: number; date: string; note: string }[];
  benefits: { id: string; title: string; completed: boolean }[];
  notes: string;
  updatedAt: string;
  revision: number;
  received: number;
  outstanding: number;
  attachments: Attachment[];
};
type Brand = {
  organization: "MAESTRO";
  accent: string;
  configured: boolean;
  logoUrl: string | null;
  logoIsDefault?: boolean;
};
const workspaceBrand = (brand: Brand): Brand => ({
  ...brand,
  logoUrl:
    brand.logoIsDefault || !brand.logoUrl
      ? originalIdentity.logoUrl
      : brand.logoUrl,
  logoIsDefault: brand.logoIsDefault ?? !brand.logoUrl,
});
type Page = "dashboard" | "sponsors" | "packages" | "team" | "brand";
type Notice = { message: string; error?: boolean };
const money = (n: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
const timestamp = (s: string) =>
  s
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Riyadh",
      }).format(new Date(s))
    : "Not saved yet";
const day = (s: string) =>
  s
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(s + "T00:00:00Z"))
    : "Not provided";
const newSponsor = (): Sponsor => ({
  id: "",
  name: "",
  packageId: "",
  packageName: "",
  contact: "",
  mobile: "",
  email: "",
  approval: "Not Approved",
  approvalDate: "",
  poIssued: false,
  poNumber: "",
  poDate: "",
  value: 0,
  payments: [],
  benefits: [],
  notes: "",
  updatedAt: "",
  revision: 0,
  received: 0,
  outstanding: 0,
  attachments: [],
});
function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={17} />
    </button>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  const id = React.useId();
  const labelControls = (nodes: React.ReactNode): React.ReactNode =>
    React.Children.map(nodes, (child) => {
      if (!React.isValidElement(child) || typeof child.type !== "string")
        return child;
      const element = child as React.ReactElement<Record<string, unknown>>;
      if (["input", "select", "textarea"].includes(child.type))
        return React.cloneElement(element, {
          "aria-labelledby": id,
          "aria-describedby": hint ? id + "-hint" : undefined,
        });
      if (element.props.children)
        return React.cloneElement(
          element,
          {},
          labelControls(element.props.children as React.ReactNode),
        );
      return child;
    });
  return (
    <label className="field">
      <span id={id}>{label}</span>
      {labelControls(children)}
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </label>
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span
      className={
        "badge " +
        (status === "Approved" || status === "Yes"
          ? "green"
          : status === "In Progress"
            ? "amber"
            : "gray")
      }
    >
      <span />
      {status}
    </span>
  );
}
function Empty({
  icon: Icon = Handshake,
  title,
  text,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={28} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const els = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ) || [],
        );
        const first = els[0],
          last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    ref.current?.focus();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={"modal " + (wide ? "wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">MAESTRO WORKSPACE</span>
            <h2>{title}</h2>
          </div>
          <IconButton icon={X} label="Close dialog" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null),
    [setup, setSetup] = useState(false),
    [loading, setLoading] = useState(true),
    [failure, setFailure] = useState("");
  const [sponsors, setSponsors] = useState<Sponsor[]>([]),
    [packages, setPackages] = useState<Package[]>([]),
    [brand, setBrand] = useState<Brand>(originalIdentity);
  const [page, setPage] = useState<Page>("dashboard"),
    [notice, setNotice] = useState<Notice | null>(null),
    [active, setActive] = useState<Sponsor | null>(null);
  const notify = (message: string, error = false) =>
    setNotice({ message, error });
  const load = async () => {
    const [s, p, b] = await Promise.all([
      api<Sponsor[]>("/sponsors"),
      api<Package[]>("/packages"),
      api<Brand>("/brand"),
    ]);
    setSponsors(s);
    setPackages(p);
    setBrand(workspaceBrand(b));
  };
  const boot = async () => {
    setLoading(true);
    setFailure("");
    try {
      const health = await api<{ setupRequired: boolean }>("/health");
      setSetup(health.setupRequired);
      if (!health.setupRequired) {
        const u = await api<User>("/me").catch(() => null);
        setUser(u);
        if (u) await load();
      }
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (connectionMissing) return;
    void boot();
    const expire = () => {
      setUser(null);
      setActive(null);
      notify("Your session expired. Please sign in again.", true);
    };
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, []);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", brand.accent);
  }, [brand.accent]);
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      if (!document.hidden) load().catch(() => {});
    }, 30000);
    return () => clearInterval(timer);
  }, [user]);
  const authenticated = async (u: User) => {
    setUser(u);
    setSetup(false);
    try {
      await load();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  if (connectionMissing)
    return (
      <div className="loading-screen">
        <LockKeyhole />
        <h1>Workspace connection required</h1>
        <p>
          The shared sponsor page needs its Supabase connection before sign-in
          and saving are available.
        </p>
      </div>
    );
  if (loading)
    return (
      <div className="loading-screen">
        <LoaderCircle className="spin" />
        <p>Opening your workspace…</p>
      </div>
    );
  if (failure)
    return (
      <div className="loading-screen">
        <AlertCircle />
        <p>{failure}</p>
        <button className="primary" onClick={() => void boot()}>
          Try again
        </button>
      </div>
    );
  if (!user)
    return (
      <>
        <Auth setup={setup} onLogin={authenticated} />
        {notice && <Toast notice={notice} close={() => setNotice(null)} />}
      </>
    );
  const editable = user.role !== "viewer";
  const logout = async () => {
    try {
      await api("/logout", "POST");
      setUser(null);
      setSponsors([]);
      setActive(null);
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  return (
    <div className="app-shell">
      <main className="main">
        <header className="single-header">
          <div
            className={
              "brand " + (brand.logoIsDefault === false ? "custom-logo" : "")
            }
          >
            {brand.logoUrl ? (
              <img src={brand.logoUrl} alt="MAESTRO" />
            ) : (
              <img src={originalIdentity.logoUrl} alt="MAESTRO" />
            )}
            <small>DIGITAL GOVERNMENT FORUM</small>
          </div>
          <div className="single-actions">
            <button className="secondary" onClick={() => setPage("packages")}>
              <Layers3 size={16} />
              Sponsorship Packages
            </button>
            {user.role === "admin" && (
              <>
                <button className="secondary" onClick={() => setPage("team")}>
                  <Users size={16} />
                  Team &amp; Access
                </button>
                <button className="secondary" onClick={() => setPage("brand")}>
                  <Palette size={16} />
                  Brand Settings
                </button>
              </>
            )}
            <span className="access-label">
              {user.name} ·{" "}
              {user.role === "admin"
                ? "Administrator"
                : user.role === "editor"
                  ? "Editor"
                  : "View only"}
            </span>
            <IconButton
              icon={LogOut}
              label="Sign out"
              onClick={() => void logout()}
            />
          </div>
        </header>
        <div className="page-content">
          <Dashboard
            sponsors={sponsors}
            packages={packages}
            editable={editable}
            open={setActive}
            notify={notify}
            refresh={load}
            sponsorOnly={false}
          />
          <footer className="footer">
            <span>
              MAESTRO <span className="footer-dot">·</span> Digital Government
              Forum
            </span>
            <span>
              Currency: SAR <span className="footer-dot">·</span> Times shown in
              Riyadh
            </span>
          </footer>
        </div>
      </main>
      {page !== "dashboard" && (
        <Modal
          wide
          title={
            page === "packages"
              ? "Sponsorship Packages"
              : page === "team"
                ? "Team & Access"
                : "Brand Settings"
          }
          onClose={() => setPage("dashboard")}
        >
          <div className="single-settings">
            {page === "packages" && (
              <Packages
                packages={packages}
                editable={editable}
                refresh={load}
                notify={notify}
              />
            )}
            {page === "team" && <Team current={user} notify={notify} />}
            {page === "brand" && (
              <BrandSettings
                brand={brand}
                onChange={(b) => setBrand(workspaceBrand(b))}
                notify={notify}
              />
            )}
          </div>
        </Modal>
      )}
      {active && (
        <SponsorPanel
          key={active.id || "new"}
          sponsor={active}
          packages={packages}
          editable={editable}
          close={() => setActive(null)}
          changed={async () => {
            await load();
          }}
          notify={notify}
        />
      )}
      {notice && <Toast notice={notice} close={() => setNotice(null)} />}
    </div>
  );
}
function Toast({ notice, close }: { notice: Notice; close: () => void }) {
  return (
    <div
      className={"toast " + (notice.error ? "error" : "")}
      role={notice.error ? "alert" : "status"}
    >
      {notice.error ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
      <span>{notice.message}</span>
      <IconButton icon={X} label="Dismiss notification" onClick={close} />
    </div>
  );
}
function Auth({
  setup,
  onLogin,
}: {
  setup: boolean;
  onLogin: (u: User) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="auth-screen">
      <div className="auth-story">
        <div className="brand">
          <img src={originalIdentity.logoUrl} alt="MAESTRO" />
          <small>PARTNERSHIP WORKSPACE</small>
        </div>
        <div>
          <span className="eyebrow">DIGITAL GOVERNMENT FORUM</span>
          <h1>
            Every partnership.
            <br />
            Perfectly orchestrated.
          </h1>
          <p>
            A considered workspace for your sponsors, commitments, and the
            details that matter.
          </p>
        </div>
        <span className="auth-foot">Sponsor Management Dashboard</span>
      </div>
      <div className="auth-panel">
        <div className="auth-card">
          <div className="auth-symbol">
            <LockKeyhole size={25} />
          </div>
          <span className="eyebrow">YOUR SHARED WORKSPACE</span>
          <h2>{setup ? "Set up your workspace" : "Welcome back"}</h2>
          <p>
            {setup
              ? "Create the first administrator account to get started."
              : "Sign in to manage your forum partnerships."}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                const data = Object.fromEntries(new FormData(e.currentTarget));
                await onLogin(
                  await api<User>(setup ? "/setup" : "/login", "POST", data),
                );
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {setup && (
              <>
                <Field
                  label="Setup Token"
                  hint="Retrieve the token from the server's protected setup-token file."
                >
                  <input
                    name="token"
                    type="password"
                    required
                    autoComplete="off"
                  />
                </Field>
                <Field label="Full Name">
                  <input
                    name="name"
                    required
                    autoComplete="name"
                    maxLength={100}
                  />
                </Field>
              </>
            )}
            <Field label="Email Address">
              <input
                type="email"
                name="email"
                required
                autoComplete="username"
                placeholder="you@organization.com"
              />
            </Field>
            <Field
              label="Password"
              hint={
                setup
                  ? "At least 12 characters. Choose a strong, unique password."
                  : undefined
              }
            >
              <input
                type="password"
                name="password"
                required
                minLength={setup ? 12 : 1}
                maxLength={128}
                autoComplete={setup ? "new-password" : "current-password"}
              />
            </Field>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary auth-submit" disabled={busy}>
              {busy ? (
                <LoaderCircle size={18} className="spin" />
              ) : setup ? (
                "Create Administrator Account"
              ) : (
                "Sign In"
              )}
              <ArrowRight size={18} />
            </button>
          </form>
          <div className="auth-security">
            <ShieldCheck size={15} />
            <span>Private workspace · Role-based access</span>
          </div>
        </div>
      </div>
    </div>
  );
}
function Dashboard({
  sponsors,
  packages,
  editable,
  open,
  notify,
  refresh,
  sponsorOnly,
}: {
  sponsors: Sponsor[];
  packages: Package[];
  editable: boolean;
  open: (s: Sponsor) => void;
  notify: (m: string, e?: boolean) => void;
  refresh: () => Promise<void>;
  sponsorOnly: boolean;
}) {
  const [search, setSearch] = useState(""),
    [packageId, setPackage] = useState(""),
    [approval, setApproval] = useState(""),
    [po, setPo] = useState(""),
    [exportBusy, setExportBusy] = useState(""),
    [refreshBusy, setRefreshBusy] = useState(false);
  const filtered = sponsors.filter(
    (s) =>
      (!search || s.name.toLowerCase().includes(search.toLowerCase())) &&
      (!packageId || s.packageId === packageId) &&
      (!approval || s.approval === approval) &&
      (!po || s.poIssued === (po === "yes")),
  );
  const total =
      sponsors.reduce((a, s) => a + Math.round(s.value * 100), 0) / 100,
    received =
      sponsors.reduce((a, s) => a + Math.round(s.received * 100), 0) / 100;
  const stats: {
    label: string;
    value: string;
    icon: LucideIcon;
    sub: string;
    currency?: boolean;
  }[] = [
    {
      label: "Total Sponsors",
      value: String(sponsors.length).padStart(2, "0"),
      icon: Handshake,
      sub: "Across all sponsorship packages",
    },
    {
      label: "Approved Sponsors",
      value: String(
        sponsors.filter((s) => s.approval === "Approved").length,
      ).padStart(2, "0"),
      icon: CheckCircle2,
      sub: "Confirmed approval status",
    },
    {
      label: "Purchase Orders Issued",
      value: String(sponsors.filter((s) => s.poIssued).length).padStart(2, "0"),
      icon: FileCheck2,
      sub: "Purchase orders marked as issued",
    },
    {
      label: "Total Sponsorship Value",
      value: money(total),
      icon: TrendingUp,
      sub: "Combined sponsorship commitment",
      currency: true,
    },
    {
      label: "Total Received",
      value: money(received),
      icon: Wallet,
      sub: "Recorded payments received",
      currency: true,
    },
    {
      label: "Outstanding Balance",
      value: money(total - received),
      icon: Clock3,
      sub: "Sponsorship value less payments",
      currency: true,
    },
  ];
  const exportFile = async (format: "excel" | "pdf") => {
    setExportBusy(format);
    try {
      const res = await request(
        "/export/" +
          format +
          "?ids=" +
          encodeURIComponent(filtered.map((s) => s.id).join(",")),
      );
      if (!res.ok) {
        if (res.status === 401)
          window.dispatchEvent(new Event("session-expired"));
        throw new Error(
          "Export could not be completed. Please sign in and try again.",
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "MAESTRO-Sponsors." + (format === "excel" ? "xlsx" : "pdf");
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Report exported successfully.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setExportBusy("");
    }
  };
  return (
    <>
      <div className="heading-row">
        <div>
          <div className="eyebrow">
            <span className="tiny-line" />
            PARTNERSHIP OVERVIEW
          </div>
          <h1>
            {sponsorOnly ? "Sponsor Directory" : "Digital Government Forum"}
          </h1>
          <p>Sponsor Management Dashboard</p>
        </div>
        <button
          className="secondary"
          disabled={refreshBusy}
          onClick={async () => {
            setRefreshBusy(true);
            try {
              await refresh();
              notify("Workspace refreshed.");
            } catch (e) {
              notify((e as Error).message, true);
            } finally {
              setRefreshBusy(false);
            }
          }}
        >
          <RefreshCw size={15} className={refreshBusy ? "spin" : ""} />
          Refresh
        </button>
      </div>
      {!sponsorOnly && (
        <>
          <section className="hero">
            <div className="hero-copy">
              <span className="eyebrow">ONE FORUM. EVERY PARTNERSHIP.</span>
              <h2>Partnerships, in perfect harmony.</h2>
              <p>
                A clear view of your sponsors, approvals, and financial
                commitments.
              </p>
              <div className="hero-bottom">
                <span>
                  <ShieldCheck size={15} />
                  Independent approval, purchase order & payment tracking
                </span>
              </div>
            </div>
          </section>
          <section className="stats-grid" aria-label="Sponsor statistics">
            {stats.map((stat, i) => (
              <article className={"stat-card stat-" + i} key={stat.label}>
                <div className="stat-top">
                  <span>{stat.label}</span>
                  <div className="stat-icon">
                    <stat.icon size={19} />
                  </div>
                </div>
                <div className="stat-value">
                  {stat.currency && <span>SAR</span>}
                  {stat.value}
                </div>
                <small>{stat.sub}</small>
              </article>
            ))}
          </section>
        </>
      )}
      <section className="table-section">
        <div className="section-heading">
          <div>
            <h2>
              Sponsor Directory{" "}
              <span className="count-pill">{sponsors.length}</span>
            </h2>
            <p>Your partnerships, organized in one place.</p>
          </div>
          <div className="section-actions">
            <details className="export-menu">
              <summary className="secondary">
                <Download size={16} />
                Export
                <ChevronDown size={14} />
              </summary>
              <div>
                <button
                  onClick={() => void exportFile("excel")}
                  disabled={!!exportBusy}
                >
                  <FileText size={16} />
                  Export to Excel
                </button>
                <button
                  onClick={() => void exportFile("pdf")}
                  disabled={!!exportBusy}
                >
                  <FileText size={16} />
                  Export to PDF
                </button>
              </div>
            </details>
            {editable && (
              <button className="primary" onClick={() => open(newSponsor())}>
                <Plus size={17} />
                Add Sponsor
              </button>
            )}
          </div>
        </div>
        <div className="filters">
          <label className="search-field">
            <Search size={18} />
            <input
              aria-label="Search sponsors"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by sponsor name…"
            />
            {search && (
              <IconButton
                icon={X}
                label="Clear search"
                onClick={() => setSearch("")}
              />
            )}
          </label>
          <select
            aria-label="Filter by sponsorship package"
            value={packageId}
            onChange={(e) => setPackage(e.target.value)}
          >
            <option value="">All Packages</option>
            {packages.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by approval status"
            value={approval}
            onChange={(e) => setApproval(e.target.value)}
          >
            <option value="">All Approval Statuses</option>
            {["Not Approved", "In Progress", "Approved"].map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <select
            aria-label="Filter by purchase order"
            value={po}
            onChange={(e) => setPo(e.target.value)}
          >
            <option value="">All Purchase Orders</option>
            <option value="yes">PO Issued: Yes</option>
            <option value="no">PO Issued: No</option>
          </select>
          {(search || packageId || approval || po) && (
            <button
              className="text-button"
              onClick={() => {
                setSearch("");
                setPackage("");
                setApproval("");
                setPo("");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Sponsor Name</th>
                <th>Sponsorship Package</th>
                <th>Approval Status</th>
                <th>Purchase Order Issued</th>
                <th className="numeric">Sponsorship Value</th>
                <th className="numeric">Outstanding Balance</th>
                <th>
                  <span className="sr-only">View details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td>
                    <button className="sponsor-name" onClick={() => open(s)}>
                      <SponsorAvatar sponsor={s} />
                      <span>
                        <strong>{s.name}</strong>
                        <small>{s.contact || "No contact added"}</small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className="package-tag">
                      {s.packageName || "Not assigned"}
                    </span>
                  </td>
                  <td>
                    <Badge status={s.approval} />
                  </td>
                  <td>
                    <Badge status={s.poIssued ? "Yes" : "No"} />
                  </td>
                  <td className="numeric">
                    {money(s.value)}
                    <small className="currency-label">SAR</small>
                  </td>
                  <td className="numeric">
                    {money(s.outstanding)}
                    <small className="currency-label">SAR</small>
                  </td>
                  <td>
                    <IconButton
                      icon={ArrowUpRight}
                      label={"View " + s.name}
                      onClick={() => open(s)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <Empty
            title={
              sponsors.length
                ? "No matching sponsors"
                : "Your next partnership starts here"
            }
            text={
              sponsors.length
                ? "Try a different search or clear the filters."
                : "Add your first sponsor to start tracking approvals, purchase orders, and payments."
            }
            action={
              editable && !sponsors.length ? (
                <button className="primary" onClick={() => open(newSponsor())}>
                  <Plus size={17} />
                  Add Sponsor
                </button>
              ) : undefined
            }
          />
        )}
        <div className="table-footer">
          <span>
            Showing {filtered.length} of {sponsors.length} sponsors
          </span>
          <span>
            <span className="status-dot" />
            Currency: SAR
          </span>
        </div>
      </section>
      <section className="complete-records" aria-label="All sponsor details">
        {filtered.map((s) => (
          <CompleteRecord
            key={s.id}
            sponsor={s}
            editable={editable}
            open={() => open(s)}
            notify={notify}
          />
        ))}
      </section>
      <div className="workspace-tip">
        <ShieldCheck size={18} />
        <p>
          Approval, purchase order issuance, and payments are tracked
          separately. Updating one never changes another.
        </p>
      </div>
    </>
  );
}
function CompleteRecord({
  sponsor: s,
  editable,
  open,
  notify,
}: {
  sponsor: Sponsor;
  editable: boolean;
  open: () => void;
  notify: (m: string, e?: boolean) => void;
}) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify("Copied to clipboard.");
    } catch {
      notify("Copy failed. Please select and copy the text.", true);
    }
  };
  const item = (label: string, value: React.ReactNode) => (
    <div>
      <dt>{label}</dt>
      <dd>{value || "Not provided"}</dd>
    </div>
  );
  return (
    <article className="complete-record">
      <header>
        <div className="record-name">
          <SponsorAvatar sponsor={s} />
          <div>
            <h2>{s.name}</h2>
            <small>Last Updated: {timestamp(s.updatedAt)}</small>
          </div>
        </div>
        <button className="secondary" onClick={open}>
          <Pencil size={16} />
          {editable ? "Edit Sponsor" : "View Sponsor"}
        </button>
      </header>
      <dl className="record-fields">
        {item("Sponsorship Package", s.packageName)}
        {item("Contact Person", s.contact)}
        {item(
          "Mobile Number",
          s.mobile && (
            <span className="record-contact">
              <a href={"tel:" + s.mobile}>{s.mobile}</a>
              <IconButton
                icon={Copy}
                label={"Copy mobile for " + s.name}
                onClick={() => void copy(s.mobile)}
              />
              <a
                href={"https://wa.me/" + s.mobile.replace(/\D/g, "")}
                target="_blank"
                rel="noreferrer"
                aria-label={"Open WhatsApp for " + s.name}
              >
                <MessageCircle size={17} />
              </a>
            </span>
          ),
        )}
        {item(
          "Email Address",
          s.email && (
            <span className="record-contact">
              <a href={"mailto:" + s.email}>{s.email}</a>
              <IconButton
                icon={Copy}
                label={"Copy email for " + s.name}
                onClick={() => void copy(s.email)}
              />
            </span>
          ),
        )}
        {item("Approval Status", <Badge status={s.approval} />)}
        {item("Approval Date", day(s.approvalDate))}
        {item(
          "Purchase Order Issued",
          <Badge status={s.poIssued ? "Yes" : "No"} />,
        )}
        {item("Purchase Order Number", s.poNumber)}
        {item("Purchase Order Date", day(s.poDate))}
        {item("Total Sponsorship Value", "SAR " + money(s.value))}
        {item("Total Received", "SAR " + money(s.received))}
        {item("Outstanding Balance", "SAR " + money(s.outstanding))}
      </dl>
      <div className="record-sections">
        <section>
          <h3>Payments Received</h3>
          {s.payments.length ? (
            <ul>
              {s.payments.map((p) => (
                <li key={p.id}>
                  <strong>SAR {money(p.amount)}</strong> · {day(p.date)}
                  {p.note && <p>{p.note}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p>No payments recorded.</p>
          )}
        </section>
        <section>
          <h3>Package Benefits</h3>
          {s.benefits.length ? (
            <ul>
              {s.benefits.map((b) => (
                <li key={b.id}>
                  <Badge status={b.completed ? "Completed" : "Pending"} />
                  {" " + b.title}
                </li>
              ))}
            </ul>
          ) : (
            <p>No benefits added.</p>
          )}
        </section>
        {(["approval", "purchase-order"] as const).map((kind) => (
          <section key={kind}>
            <h3>
              {kind === "approval"
                ? "Approval Attachments"
                : "Purchase Order Attachments"}
            </h3>
            {s.attachments.filter((a) => a.kind === kind).length ? (
              <ul>
                {s.attachments
                  .filter((a) => a.kind === kind)
                  .map((a) => (
                    <li key={a.id}>
                      <button
                        className="text-button"
                        onClick={() => setPreview(a)}
                      >
                        <Eye size={15} />
                        {a.name}
                      </button>
                      <a
                        href={attachmentUrl(a, true)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={"Download " + a.name}
                      >
                        <Download size={15} />
                      </a>
                    </li>
                  ))}
              </ul>
            ) : (
              <p>No attachments uploaded.</p>
            )}
          </section>
        ))}
      </div>
      {s.notes && (
        <div className="record-notes">
          <h3>Notes</h3>
          <p>{s.notes}</p>
        </div>
      )}
      {preview && (
        <Preview attachment={preview} close={() => setPreview(null)} />
      )}
    </article>
  );
}

function SponsorAvatar({ sponsor }: { sponsor: Sponsor }) {
  const logo = sponsor.attachments.find((a) => a.kind === "logo");
  return (
    <div className="sponsor-avatar">
      {logo ? (
        <img src={attachmentUrl(logo)} alt={sponsor.name + " logo"} />
      ) : (
        <Building2 size={20} />
      )}
    </div>
  );
}
function SponsorPanel({
  sponsor,
  packages,
  editable,
  close,
  changed,
  notify,
}: {
  sponsor: Sponsor;
  packages: Package[];
  editable: boolean;
  close: () => void;
  changed: () => Promise<void>;
  notify: (m: string, e?: boolean) => void;
}) {
  const [draft, setDraft] = useState<Sponsor>(() => structuredClone(sponsor)),
    [baseline, setBaseline] = useState(JSON.stringify(sponsor)),
    [tab, setTab] = useState("Overview"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<Attachment | null>(null);
  const [payment, setPayment] = useState({ amount: "", date: "", note: "" }),
    [benefit, setBenefit] = useState("");
  const [editingPayment, setEditingPayment] = useState<string | null>(null);
  const [pendingLogo, setPendingLogo] = useState<File | null>(null),
    [pendingLogoUrl, setPendingLogoUrl] = useState("");
  const logoInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!pendingLogo) {
      setPendingLogoUrl("");
      return;
    }
    const url = URL.createObjectURL(pendingLogo);
    setPendingLogoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingLogo]);
  const selectedPackage = packages.find((p) => p.id === draft.packageId);
  const dirty = JSON.stringify(draft) !== baseline,
    unsaved = dirty || Boolean(pendingLogo),
    paid =
      draft.payments.reduce((a, p) => a + Math.round(p.amount * 100), 0) / 100,
    balance = (Math.round(draft.value * 100) - Math.round(paid * 100)) / 100;
  const set = <K extends keyof Sponsor>(key: K, value: Sponsor[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const accept = (s: Sponsor) => {
    setDraft(s);
    setBaseline(JSON.stringify(s));
  };
  const closePanel = () => {
    if (busy) return;
    if (preview) {
      setPreview(null);
      return;
    }
    if (!unsaved || window.confirm("Discard your unsaved changes?")) close();
  };
  const persistLogo = async (saved: Sponsor, file: File) => {
    const existingLogo = saved.attachments.find((a) => a.kind === "logo");
    const form = new FormData();
    if (existingLogo) form.set("file", file);
    else {
      form.set("kind", "logo");
      form.append("files", file);
    }
    return api<Sponsor>(
      existingLogo
        ? "/attachments/" + existingLogo.id + "/replace"
        : "/sponsors/" + saved.id + "/attachments",
      "POST",
      form,
    );
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let saved = draft;
      if (dirty || !draft.id) {
        saved = await api<Sponsor>(
          draft.id ? "/sponsors/" + draft.id : "/sponsors",
          draft.id ? "PUT" : "POST",
          draft,
        );
        accept(saved);
      }
      if (pendingLogo) {
        try {
          saved = await persistLogo(saved, pendingLogo);
          accept(saved);
          setPendingLogo(null);
        } catch (err) {
          await changed();
          throw new Error(
            "Sponsor saved, but the logo could not be uploaded. " +
              (err as Error).message +
              " Your selected logo is ready to retry with Save Changes.",
          );
        }
      }
      notify(
        draft.id
          ? "Sponsor updated successfully."
          : "Sponsor created successfully.",
      );
      await changed();
    } catch (err) {
      setError((err as Error).message);
      notify((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const selectLogo = (file: File | undefined) => {
    if (!file || busy || !editable) return;
    let message = "";
    const supported =
      ["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      (!file.type && /\.(png|jpe?g|webp)$/i.test(file.name));
    if (!supported) message = "Choose a PNG, JPEG or WebP sponsor logo.";
    else if (!file.size) message = "Choose a logo file that is not empty.";
    else if (file.size > 10 * 1024 * 1024)
      message = "Sponsor logos must be 10 MB or smaller.";
    if (message) {
      setError(message);
      notify(message, true);
      return;
    }
    setError("");
    setPendingLogo(file);
  };
  const mutation = async (url: string, method: string, body?: unknown) => {
    if (dirty) {
      notify("Save your changes before managing attachments.", true);
      return;
    }
    setBusy(true);
    try {
      accept(await api<Sponsor>(url, method, body));
      await changed();
      notify("Attachment updated successfully.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const upload = (files: FileList | null, kind: Attachment["kind"]) => {
    if (!files?.length) return;
    const form = new FormData();
    form.set("kind", kind);
    Array.from(files).forEach((f) => form.append("files", f));
    void mutation("/sponsors/" + draft.id + "/attachments", "POST", form);
  };
  const replace = (file: File | undefined, a: Attachment) => {
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    void mutation("/attachments/" + a.id + "/replace", "POST", form);
  };
  const removeAttachment = (a: Attachment) => {
    if (
      window.confirm(
        'Delete "' + a.name + '"? This permanently removes the attachment.',
      )
    )
      void mutation("/attachments/" + a.id, "DELETE");
  };
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify("Copied to clipboard.");
    } catch {
      notify(
        "Copy is unavailable in this browser. Select and copy the value manually.",
        true,
      );
    }
  };
  const logo = draft.attachments.find((a) => a.kind === "logo");
  const attachmentCard = (a: Attachment) => (
    <div className="attachment-card" key={a.id}>
      <button
        className="attachment-thumb"
        type="button"
        onClick={() => setPreview(a)}
        aria-label={"Preview " + a.name}
      >
        {a.mime.startsWith("image/") ? (
          <img src={attachmentUrl(a)} alt={a.name} />
        ) : (
          <FileText size={25} />
        )}
      </button>
      <div className="attachment-info">
        <strong>{a.name}</strong>
        <span>
          {(a.size / 1024).toFixed(0)} KB · {timestamp(a.createdAt)}
        </span>
      </div>
      <div className="attachment-actions">
        <IconButton
          icon={Eye}
          label={"Preview " + a.name}
          onClick={() => setPreview(a)}
        />
        <a
          className="icon-button"
          href={attachmentUrl(a, true)}
          aria-label={"Download " + a.name}
        >
          <Download size={16} />
        </a>
        {editable && (
          <>
            <label
              className={"icon-button " + (busy || dirty ? "disabled" : "")}
              title="Replace attachment"
            >
              <RefreshCw size={16} />
              <span className="sr-only">Replace {a.name}</span>
              <input
                className="file-input"
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                disabled={busy || dirty}
                onChange={(e) => {
                  replace(e.target.files?.[0], a);
                  e.target.value = "";
                }}
              />
            </label>
            <IconButton
              icon={Trash2}
              label={"Delete " + a.name}
              onClick={() => removeAttachment(a)}
              disabled={busy || dirty}
            />
          </>
        )}
      </div>
    </div>
  );
  return (
    <Modal
      title={draft.id ? draft.name : "Add Sponsor"}
      onClose={closePanel}
      wide
    >
      <div className="detail-intro">
        <SponsorAvatar sponsor={draft} />
        <div>
          <span className="eyebrow">SPONSOR RECORD</span>
          <strong>{draft.packageName || "Package not assigned"}</strong>
        </div>
        {draft.id && <Badge status={draft.approval} />}
      </div>
      <div className="detail-tabs" role="tablist">
        {[
          "Overview",
          "Contact Details",
          "Financials",
          "Package Benefits",
          "Attachments",
        ].map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <form className="detail-form" onSubmit={save}>
        <div className="detail-body" role="tabpanel">
          {tab === "Overview" && (
            <>
              <div className="section-title">
                <h3>Sponsor Information</h3>
                <p>The foundation of this partnership.</p>
              </div>
              <Field label="Sponsor Name">
                <input
                  required
                  maxLength={200}
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  disabled={!editable}
                  placeholder="Enter sponsor organization name"
                />
              </Field>
              <div className="form-grid">
                <Field
                  label="Sponsorship Package"
                  hint={
                    "Default benefits are copied when a package is selected. Existing benefits are kept unless you confirm replacement." +
                    (selectedPackage?.referenceValue !== undefined
                      ? ` Package reference value: SAR ${money(selectedPackage.referenceValue)}. Enter the agreed amount in Financials.`
                      : "")
                  }
                >
                  <select
                    value={draft.packageId}
                    disabled={!editable}
                    onChange={(e) => {
                      const pkg = packages.find((p) => p.id === e.target.value);
                      let benefits = draft.benefits;
                      if (
                        pkg &&
                        (!benefits.length ||
                          window.confirm(
                            "Replace this sponsor’s existing benefits with the selected package’s defaults?",
                          ))
                      )
                        benefits = pkg.benefits.map((title) => ({
                          id: crypto.randomUUID(),
                          title,
                          completed: false,
                        }));
                      setDraft((d) => ({
                        ...d,
                        packageId: pkg?.id || "",
                        packageName: pkg?.name || "",
                        benefits,
                      }));
                    }}
                  >
                    <option value="">Select a package</option>
                    {packages.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="field">
                  <span>Sponsor Logo</span>
                  <div className="logo-upload">
                    {editable ? (
                      <button
                        type="button"
                        className="logo-picker"
                        aria-label="Choose sponsor logo"
                        title="Choose sponsor logo"
                        disabled={busy}
                        onClick={() => logoInput.current?.click()}
                      >
                        {pendingLogoUrl ? (
                          <img
                            src={pendingLogoUrl}
                            alt="Selected sponsor logo"
                          />
                        ) : logo ? (
                          <img src={attachmentUrl(logo)} alt="Sponsor logo" />
                        ) : (
                          <Upload size={24} />
                        )}
                      </button>
                    ) : logo ? (
                      <img src={attachmentUrl(logo)} alt="Sponsor logo" />
                    ) : (
                      <Building2 size={26} />
                    )}
                    <div>
                      {pendingLogo ? (
                        <span>{pendingLogo.name}</span>
                      ) : logo ? (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setPreview(logo)}
                        >
                          View logo
                        </button>
                      ) : (
                        <span>No logo uploaded</span>
                      )}
                      {editable && (
                        <button
                          type="button"
                          className="text-button sponsor-logo-action"
                          disabled={busy}
                          aria-label={
                            logo || pendingLogo
                              ? "Replace Sponsor Logo"
                              : "Upload Sponsor Logo"
                          }
                          onClick={() => logoInput.current?.click()}
                        >
                          <Upload size={15} />
                          {logo || pendingLogo ? "Replace logo" : "Upload logo"}
                        </button>
                      )}
                    </div>
                    {editable && (
                      <input
                        ref={logoInput}
                        className="file-input"
                        type="file"
                        tabIndex={-1}
                        aria-label="Sponsor logo file"
                        accept="image/png,image/jpeg,image/webp"
                        disabled={busy}
                        onChange={(e) => {
                          selectLogo(e.target.files?.[0]);
                          e.target.value = "";
                        }}
                      />
                    )}
                    {pendingLogo && editable ? (
                      <IconButton
                        icon={X}
                        label="Remove selected logo"
                        onClick={() => setPendingLogo(null)}
                        disabled={busy}
                      />
                    ) : (
                      logo &&
                      editable && (
                        <IconButton
                          icon={Trash2}
                          label="Delete sponsor logo"
                          onClick={() => removeAttachment(logo)}
                          disabled={busy || dirty}
                        />
                      )
                    )}
                  </div>
                  <small>
                    {pendingLogo
                      ? "Logo selected. Save the sponsor to upload it."
                      : editable
                        ? "PNG, JPEG or WebP · Up to 10 MB. Choose a logo, then save the sponsor."
                        : "PNG, JPEG or WebP · Up to 10 MB"}
                  </small>
                </div>
              </div>
              <div className="section-title separated">
                <h3>Approval & Purchase Order</h3>
                <p>Each status is managed independently.</p>
              </div>
              <div className="form-grid">
                <Field label="Approval Status">
                  <select
                    value={draft.approval}
                    disabled={!editable}
                    onChange={(e) =>
                      set("approval", e.target.value as Sponsor["approval"])
                    }
                  >
                    {["Not Approved", "In Progress", "Approved"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Approval Date">
                  <input
                    type="date"
                    value={draft.approvalDate}
                    disabled={!editable}
                    onChange={(e) => set("approvalDate", e.target.value)}
                  />
                </Field>
                <Field label="Purchase Order Issued">
                  <select
                    value={draft.poIssued ? "yes" : "no"}
                    disabled={!editable}
                    onChange={(e) => set("poIssued", e.target.value === "yes")}
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </Field>
                <Field label="Purchase Order Number">
                  <input
                    value={draft.poNumber}
                    disabled={!editable}
                    onChange={(e) => set("poNumber", e.target.value)}
                    maxLength={100}
                    placeholder="Enter purchase order number"
                  />
                </Field>
                <Field label="Purchase Order Date">
                  <input
                    type="date"
                    value={draft.poDate}
                    disabled={!editable}
                    onChange={(e) => set("poDate", e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Notes">
                <textarea
                  value={draft.notes}
                  disabled={!editable}
                  rows={3}
                  maxLength={3000}
                  onChange={(e) => set("notes", e.target.value)}
                  placeholder="Optional internal notes"
                />
              </Field>
            </>
          )}
          {tab === "Contact Details" && (
            <>
              <div className="section-title">
                <h3>Contact Details</h3>
                <p>Keep the right people within reach.</p>
              </div>
              <Field label="Contact Person">
                <input
                  value={draft.contact}
                  disabled={!editable}
                  maxLength={100}
                  onChange={(e) => set("contact", e.target.value)}
                  placeholder="Enter contact person’s name"
                />
              </Field>
              <Field
                label="Mobile Number"
                hint="Include the country code, with no spaces. For example: +966501234567."
              >
                <input
                  type="tel"
                  value={draft.mobile}
                  disabled={!editable}
                  pattern="\+[1-9][0-9]{6,14}"
                  onChange={(e) => set("mobile", e.target.value)}
                  placeholder="+CountryCodeNumber"
                />
              </Field>
              {draft.mobile && (
                <div className="contact-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void copy(draft.mobile)}
                  >
                    <Copy size={16} />
                    Copy number
                  </button>
                  <a className="secondary" href={"tel:" + draft.mobile}>
                    <Phone size={16} />
                    Call
                  </a>
                  <a
                    className="secondary"
                    href={"https://wa.me/" + draft.mobile.replace(/\D/g, "")}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <MessageCircle size={16} />
                    Open WhatsApp
                    <ExternalLink size={12} />
                  </a>
                </div>
              )}
              <Field label="Email Address">
                <input
                  type="email"
                  value={draft.email}
                  disabled={!editable}
                  onChange={(e) => set("email", e.target.value)}
                  placeholder="contact@organization.com"
                />
              </Field>
              {draft.email && (
                <div className="contact-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void copy(draft.email)}
                  >
                    <Copy size={16} />
                    Copy email
                  </button>
                  <a className="secondary" href={"mailto:" + draft.email}>
                    <Mail size={16} />
                    Open email app
                  </a>
                </div>
              )}
              <div className="info-note">
                <ShieldCheck size={18} />
                <span>
                  Contact actions open your chosen app. No messages are sent
                  automatically.
                </span>
              </div>
            </>
          )}
          {tab === "Financials" && (
            <>
              <div className="section-title">
                <h3>Financial Overview</h3>
                <p>Currency: SAR · Values are tracked to two decimal places.</p>
              </div>
              <Field
                label="Total Sponsorship Value"
                hint={
                  selectedPackage?.referenceValue !== undefined
                    ? `Package reference value: SAR ${money(selectedPackage.referenceValue)}. Enter the agreed sponsorship amount.`
                    : "Enter the agreed sponsorship amount."
                }
              >
                <div className="input-prefix">
                  <span>SAR</span>
                  <input
                    type="number"
                    min="0"
                    max="9999999999"
                    step="0.01"
                    value={draft.value}
                    disabled={!editable}
                    onChange={(e) => set("value", Number(e.target.value))}
                  />
                </div>
              </Field>
              <div className="financial-cards">
                <div>
                  <span>Total Received</span>
                  <strong>
                    <small>SAR</small>
                    {money(paid)}
                  </strong>
                </div>
                <div>
                  <span>Outstanding Balance</span>
                  <strong>
                    <small>SAR</small>
                    {money(balance)}
                  </strong>
                </div>
              </div>
              <div className="section-title separated">
                <h3>
                  Payments Received{" "}
                  <span className="count-pill">{draft.payments.length}</span>
                </h3>
                <p>Record each received payment with its amount and date.</p>
              </div>
              {draft.payments.length ? (
                <div className="payment-list">
                  {draft.payments.map((p) => (
                    <div className="payment-row" key={p.id}>
                      <div className="payment-icon">
                        <CreditCard size={20} />
                      </div>
                      <div>
                        <strong>SAR {money(p.amount)}</strong>
                        <span>
                          {day(p.date)}
                          {p.note ? " · " + p.note : ""}
                        </span>
                      </div>
                      {editable && (
                        <IconButton
                          icon={Pencil}
                          label="Edit payment"
                          onClick={() => {
                            setEditingPayment(p.id);
                            setPayment({
                              amount: String(p.amount),
                              date: p.date,
                              note: p.note,
                            });
                          }}
                        />
                      )}
                      {editable && (
                        <IconButton
                          icon={Trash2}
                          label="Remove payment"
                          onClick={() => {
                            if (
                              window.confirm(
                                "Remove this payment? Save Changes to confirm the update.",
                              )
                            ) {
                              set(
                                "payments",
                                draft.payments.filter((x) => x.id !== p.id),
                              );
                              if (editingPayment === p.id) {
                                setEditingPayment(null);
                                setPayment({ amount: "", date: "", note: "" });
                              }
                            }
                          }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="quiet-empty">No payments recorded.</div>
              )}
              {editable && (
                <div className="add-payment">
                  <div className="form-grid">
                    <Field label="Payment Amount">
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={payment.amount}
                        onChange={(e) =>
                          setPayment((p) => ({ ...p, amount: e.target.value }))
                        }
                        placeholder="0.00"
                      />
                    </Field>
                    <Field label="Payment Date">
                      <input
                        type="date"
                        value={payment.date}
                        onChange={(e) =>
                          setPayment((p) => ({ ...p, date: e.target.value }))
                        }
                      />
                    </Field>
                  </div>
                  <Field label="Payment Note">
                    <input
                      value={payment.note}
                      maxLength={300}
                      onChange={(e) =>
                        setPayment((p) => ({ ...p, note: e.target.value }))
                      }
                      placeholder="Optional payment reference"
                    />
                  </Field>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      const n = Number(payment.amount);
                      if (
                        !Number.isFinite(n) ||
                        n <= 0 ||
                        n > 9999999999 ||
                        !payment.date ||
                        Math.abs(n * 100 - Math.round(n * 100)) > 0.0001
                      ) {
                        notify(
                          "Enter a valid payment amount with up to two decimal places and a payment date.",
                          true,
                        );
                        return;
                      }
                      const record = {
                        id: editingPayment || crypto.randomUUID(),
                        amount: n,
                        date: payment.date,
                        note: payment.note,
                      };
                      set(
                        "payments",
                        editingPayment
                          ? draft.payments.map((p) =>
                              p.id === editingPayment ? record : p,
                            )
                          : [...draft.payments, record],
                      );
                      setPayment({ amount: "", date: "", note: "" });
                      setEditingPayment(null);
                      notify("Payment updated. Save Changes to keep it.");
                    }}
                  >
                    <Plus size={16} />
                    {editingPayment ? "Save Payment" : "Add Payment"}
                  </button>
                  {editingPayment && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setEditingPayment(null);
                        setPayment({ amount: "", date: "", note: "" });
                      }}
                    >
                      Cancel payment edit
                    </button>
                  )}
                </div>
              )}
              <div className="info-note">
                <AlertCircle size={18} />
                <span>
                  Recording a payment does not change approval or purchase order
                  status.
                </span>
              </div>
            </>
          )}
          {tab === "Package Benefits" && (
            <>
              <div className="section-title">
                <h3>Package Benefits</h3>
                <p>Track every commitment, from planned to delivered.</p>
              </div>
              <div className="benefit-summary">
                <span>
                  {draft.benefits.filter((b) => b.completed).length} of{" "}
                  {draft.benefits.length} completed
                </span>
                <div className="progress-track">
                  <div
                    style={{
                      width:
                        (draft.benefits.length
                          ? (draft.benefits.filter((b) => b.completed).length /
                              draft.benefits.length) *
                            100
                          : 0) + "%",
                    }}
                  />
                </div>
              </div>
              {draft.benefits.length ? (
                <div className="benefit-list">
                  {draft.benefits.map((b) => (
                    <div
                      className={
                        "benefit-row " + (b.completed ? "complete" : "")
                      }
                      key={b.id}
                    >
                      <input
                        type="checkbox"
                        aria-label={"Mark " + b.title + " complete"}
                        checked={b.completed}
                        disabled={!editable}
                        onChange={(e) =>
                          set(
                            "benefits",
                            draft.benefits.map((x) =>
                              x.id === b.id
                                ? { ...x, completed: e.target.checked }
                                : x,
                            ),
                          )
                        }
                      />
                      <input
                        aria-label="Benefit description"
                        value={b.title}
                        maxLength={300}
                        disabled={!editable}
                        onChange={(e) =>
                          set(
                            "benefits",
                            draft.benefits.map((x) =>
                              x.id === b.id
                                ? { ...x, title: e.target.value }
                                : x,
                            ),
                          )
                        }
                      />
                      <span className="benefit-status">
                        {b.completed ? "Completed" : "Pending"}
                      </span>
                      {editable && (
                        <IconButton
                          icon={Trash2}
                          label="Remove benefit"
                          onClick={() =>
                            set(
                              "benefits",
                              draft.benefits.filter((x) => x.id !== b.id),
                            )
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="quiet-empty">No package benefits added.</div>
              )}
              {editable && (
                <div className="inline-add">
                  <input
                    aria-label="New benefit"
                    value={benefit}
                    maxLength={300}
                    onChange={(e) => setBenefit(e.target.value)}
                    placeholder="Describe a package benefit"
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={!benefit.trim()}
                    onClick={() => {
                      set("benefits", [
                        ...draft.benefits,
                        {
                          id: crypto.randomUUID(),
                          title: benefit.trim(),
                          completed: false,
                        },
                      ]);
                      setBenefit("");
                    }}
                  >
                    <Plus size={16} />
                    Add Benefit
                  </button>
                </div>
              )}
              <div className="info-note">
                <Layers3 size={18} />
                <span>
                  These benefits belong to this sponsor. Editing package
                  defaults does not overwrite existing commitments.
                </span>
              </div>
            </>
          )}
          {tab === "Attachments" && (
            <>
              <div className="section-title">
                <h3>Documents & Attachments</h3>
                <p>
                  PNG, JPEG, WebP and PDF · 10 MB per file · Up to 10 files per
                  upload
                </p>
              </div>
              {(!draft.id || dirty) && (
                <div className="info-note">
                  <AlertCircle size={18} />
                  <span>
                    {!draft.id
                      ? "Save the sponsor before uploading attachments."
                      : "Save your changes before uploading, replacing, or deleting attachments."}
                  </span>
                </div>
              )}
              {(["approval", "purchase-order"] as const).map((kind) => (
                <section className="attachment-section" key={kind}>
                  <div className="attachment-section-header">
                    <h3>
                      {kind === "approval"
                        ? "Approval Attachments"
                        : "Purchase Order Attachments"}
                    </h3>
                    <span className="count-pill">
                      {draft.attachments.filter((a) => a.kind === kind).length}
                    </span>
                  </div>
                  {draft.attachments
                    .filter((a) => a.kind === kind)
                    .map(attachmentCard)}
                  {!draft.attachments.some((a) => a.kind === kind) && (
                    <div className="quiet-empty">
                      No {kind === "approval" ? "approval" : "purchase order"}{" "}
                      attachments.
                    </div>
                  )}
                  {editable && (
                    <label
                      className={
                        "upload-zone " +
                        (!draft.id || busy || dirty ? "disabled" : "")
                      }
                    >
                      <Upload size={22} />
                      <strong>Choose files to upload</strong>
                      <span>Images or PDF documents</span>
                      <input
                        className="file-input"
                        aria-label={
                          "Upload " +
                          (kind === "approval"
                            ? "approval"
                            : "purchase order") +
                          " attachments"
                        }
                        type="file"
                        accept="image/png,image/jpeg,image/webp,application/pdf"
                        multiple
                        disabled={!draft.id || busy || dirty}
                        onChange={(e) => {
                          upload(e.target.files, kind);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  )}
                </section>
              ))}
            </>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="detail-footer">
          <div>
            <span>Last Updated</span>
            <strong>
              {timestamp(draft.updatedAt)}
              {draft.updatedAt ? " · Riyadh" : ""}
            </strong>
            {unsaved && <small className="unsaved">Unsaved changes</small>}
          </div>
          <div className="detail-footer-actions">
            {editable && draft.id && (
              <button
                type="button"
                className="danger-text"
                disabled={busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Delete this sponsor and all its attachments? This cannot be undone.",
                    )
                  )
                    return;
                  setBusy(true);
                  try {
                    await api("/sponsors/" + draft.id, "DELETE");
                    await changed();
                    notify("Sponsor deleted.");
                    close();
                  } catch (e) {
                    notify((e as Error).message, true);
                    setBusy(false);
                  }
                }}
              >
                <Trash2 size={16} />
                <span>Delete</span>
              </button>
            )}
            <button
              type="button"
              className="secondary"
              onClick={closePanel}
              disabled={busy}
            >
              {editable ? "Cancel" : "Close"}
            </button>
            {editable && (
              <button
                className="primary"
                disabled={busy || (!unsaved && !!draft.id)}
              >
                {busy ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Check size={16} />
                )}
                <span>{draft.id ? "Save Changes" : "Create Sponsor"}</span>
              </button>
            )}
          </div>
        </div>
      </form>
      {preview && (
        <Preview attachment={preview} close={() => setPreview(null)} />
      )}
    </Modal>
  );
}
function Preview({
  attachment,
  close,
}: {
  attachment: Attachment;
  close: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  return (
    <div
      className="preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={"Preview " + attachment.name}
    >
      <div className="preview-toolbar">
        <strong>{attachment.name}</strong>
        <div>
          {attachment.mime.startsWith("image/") && (
            <>
              <IconButton
                icon={ZoomOut}
                label="Zoom out"
                onClick={() => setZoom((v) => Math.max(0.5, v - 0.25))}
              />
              <span>{Math.round(zoom * 100)}%</span>
              <IconButton
                icon={ZoomIn}
                label="Zoom in"
                onClick={() => setZoom((v) => Math.min(4, v + 0.25))}
              />
            </>
          )}
          <a
            className="icon-button"
            href={attachmentUrl(attachment, true)}
            aria-label="Download attachment"
          >
            <Download size={18} />
          </a>
          <IconButton icon={X} label="Close preview" onClick={close} />
        </div>
      </div>
      <div className="preview-body">
        {attachment.mime.startsWith("image/") ? (
          <img
            src={attachmentUrl(attachment)}
            alt={attachment.name}
            style={{ width: zoom * 100 + "%", maxWidth: "none" }}
          />
        ) : (
          <iframe src={attachmentUrl(attachment)} title={attachment.name} />
        )}
      </div>
      <p className="preview-caption">
        If your browser cannot display this file, use Download to open it in
        your preferred viewer.
      </p>
    </div>
  );
}

function Packages({
  packages,
  editable,
  refresh,
  notify,
}: {
  packages: Package[];
  editable: boolean;
  refresh: () => Promise<void>;
  notify: (m: string, e?: boolean) => void;
}) {
  const [active, setActive] = useState<Package | null>(null),
    [benefit, setBenefit] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <div className="heading-row">
        <div>
          <div className="eyebrow">
            <span className="tiny-line" />
            PARTNERSHIP STRUCTURE
          </div>
          <h1>Sponsorship Packages</h1>
          <p>Create your packages and define what each partnership includes.</p>
        </div>
        {editable && (
          <button
            className="primary"
            onClick={() => {
              setActive({ id: "", name: "", benefits: [] });
              setBenefit("");
              setError("");
            }}
          >
            <Plus size={17} />
            Add Package
          </button>
        )}
      </div>
      <div className="info-note">
        <Layers3 size={18} />
        <span>
          Package defaults are copied to a sponsor when selected. Existing
          sponsor benefits remain independent.
        </span>
      </div>
      {packages.length ? (
        <div className="package-grid">
          {packages.map((p) => (
            <article className="package-card" key={p.id}>
              <div className="package-card-top">
                <div className="empty-icon">
                  <Layers3 size={25} />
                </div>
                {editable && (
                  <div>
                    <button
                      className="text-button"
                      onClick={() => {
                        setActive(structuredClone(p));
                        setBenefit("");
                        setError("");
                      }}
                    >
                      Edit
                    </button>
                    <IconButton
                      icon={Trash2}
                      label={"Delete " + p.name}
                      onClick={async () => {
                        if (
                          !window.confirm("Delete the " + p.name + " package?")
                        )
                          return;
                        try {
                          await api("/packages/" + p.id, "DELETE");
                          await refresh();
                          notify("Package deleted.");
                        } catch (e) {
                          notify((e as Error).message, true);
                        }
                      }}
                    />
                  </div>
                )}
              </div>
              <h2>{p.name}</h2>
              {p.referenceValue !== undefined && (
                <div className="package-price">
                  <span>Reference Value · SAR</span>
                  <strong>{money(p.referenceValue)}</strong>
                </div>
              )}
              <span className="muted">
                {p.benefits.length} package benefits
              </span>
              <ul>
                {p.benefits.map((b, i) => (
                  <li key={i}>
                    <Check size={16} />
                    {b}
                  </li>
                ))}
              </ul>
              {!p.benefits.length && (
                <p className="muted">No default benefits defined.</p>
              )}
            </article>
          ))}
        </div>
      ) : (
        <section className="table-section">
          <Empty
            icon={Layers3}
            title="Shape your sponsorship offering"
            text="Add the packages offered by the forum and define their benefits."
            action={
              editable ? (
                <button
                  className="primary"
                  onClick={() => setActive({ id: "", name: "", benefits: [] })}
                >
                  <Plus size={17} />
                  Add Package
                </button>
              ) : undefined
            }
          />
        </section>
      )}
      {active && (
        <Modal
          title={active.id ? "Edit Package" : "Add Package"}
          onClose={() => {
            if (!busy) setActive(null);
          }}
        >
          <form
            className="settings-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await api(
                  active.id ? "/packages/" + active.id : "/packages",
                  active.id ? "PUT" : "POST",
                  active,
                );
                await refresh();
                setActive(null);
                notify("Package saved successfully.");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Package Name">
              <input
                required
                maxLength={100}
                value={active.name}
                onChange={(e) => setActive({ ...active, name: e.target.value })}
              />
            </Field>
            <Field
              label="Package Reference Value"
              hint="Currency: SAR. Enter the agreed amount separately for each sponsor."
            >
              <div className="input-prefix">
                <span>SAR</span>
                <input
                  type="number"
                  min="0"
                  max="9999999999"
                  step="0.01"
                  value={active.referenceValue ?? ""}
                  placeholder="Optional catalogue price"
                  onChange={(e) =>
                    setActive({
                      ...active,
                      referenceValue:
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                    })
                  }
                />
              </div>
            </Field>
            <div className="section-title">
              <h3>Default Benefits</h3>
              <p>Editable commitments for sponsors on this package.</p>
            </div>
            {active.benefits.map((b, i) => (
              <div className="inline-add" key={i}>
                <input
                  aria-label={"Default benefit " + (i + 1)}
                  required
                  maxLength={300}
                  value={b}
                  onChange={(e) =>
                    setActive({
                      ...active,
                      benefits: active.benefits.map((v, j) =>
                        i === j ? e.target.value : v,
                      ),
                    })
                  }
                />
                <IconButton
                  icon={Trash2}
                  label="Remove default benefit"
                  onClick={() =>
                    setActive({
                      ...active,
                      benefits: active.benefits.filter((_, j) => j !== i),
                    })
                  }
                />
              </div>
            ))}
            <div className="inline-add">
              <input
                aria-label="New default benefit"
                value={benefit}
                maxLength={300}
                onChange={(e) => setBenefit(e.target.value)}
                placeholder="Describe a default benefit"
              />
              <button
                type="button"
                className="secondary"
                disabled={!benefit.trim()}
                onClick={() => {
                  setActive({
                    ...active,
                    benefits: [...active.benefits, benefit.trim()],
                  });
                  setBenefit("");
                }}
              >
                <Plus size={16} />
                Add
              </button>
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setActive(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Check size={16} />
                )}
                Save Package
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function Team({
  current,
  notify,
}: {
  current: User;
  notify: (m: string, e?: boolean) => void;
}) {
  const [users, setUsers] = useState<User[]>([]),
    [add, setAdd] = useState(false),
    [edit, setEdit] = useState<User | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = async () => setUsers(await api<User[]>("/users"));
  useEffect(() => {
    load().catch((e) => notify(e.message, true));
  }, []);
  return (
    <>
      <div className="heading-row">
        <div>
          <div className="eyebrow">
            <span className="tiny-line" />
            SHARED RESPONSIBILITY
          </div>
          <h1>Team & Access</h1>
          <p>Give each member the right level of access.</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setAdd(true);
            setError("");
          }}
        >
          <Plus size={17} />
          Add Team Member
        </button>
      </div>
      <div className="roles-grid">
        {[
          {
            title: "Administrator",
            text: "Manage sponsors, packages, branding, and team access.",
            icon: ShieldCheck,
          },
          {
            title: "Editor",
            text: "Create and edit sponsor records, files, and packages.",
            icon: Handshake,
          },
          {
            title: "Viewer",
            text: "View sponsor records, download files, and export reports.",
            icon: Eye,
          },
        ].map((r) => (
          <div className="role-card" key={r.title}>
            <r.icon size={23} />
            <h3>{r.title}</h3>
            <p>{r.text}</p>
          </div>
        ))}
      </div>
      <section className="table-section">
        <div className="section-heading">
          <h2>
            Workspace Members <span className="count-pill">{users.length}</span>
          </h2>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Email Address</th>
                <th>Role</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong>
                    {u.id === current.id && (
                      <small className="you-label">You</small>
                    )}
                  </td>
                  <td>{u.email}</td>
                  <td>
                    {u.role === "admin"
                      ? "Administrator"
                      : u.role === "editor"
                        ? "Editor"
                        : "Viewer"}
                  </td>
                  <td>
                    <Badge status={u.active ? "Active" : "Inactive"} />
                  </td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => {
                        setEdit(u);
                        setError("");
                      }}
                    >
                      Manage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {(add || edit) && (
        <Modal
          title={edit ? "Manage Team Member" : "Add Team Member"}
          onClose={() => {
            if (!busy) {
              setAdd(false);
              setEdit(null);
            }
          }}
        >
          <form
            className="settings-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              const input = Object.fromEntries(new FormData(e.currentTarget));
              try {
                if (edit) {
                  const body = {
                    role: input.role,
                    active: input.active === "yes",
                    ...(input.password ? { password: input.password } : {}),
                  };
                  await api("/users/" + edit.id, "PATCH", body);
                } else await api("/users", "POST", input);
                await load();
                setAdd(false);
                setEdit(null);
                notify("Team access saved.");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {edit ? (
              <div className="member-heading">
                <strong>{edit.name}</strong>
                <span>{edit.email}</span>
              </div>
            ) : (
              <>
                <Field label="Full Name">
                  <input name="name" required maxLength={100} />
                </Field>
                <Field label="Email Address">
                  <input name="email" type="email" required />
                </Field>
              </>
            )}
            <Field label="Role">
              <select name="role" defaultValue={edit?.role || "viewer"}>
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="admin">Administrator</option>
              </select>
            </Field>
            {edit && (
              <Field label="Account Status">
                <select name="active" defaultValue={edit.active ? "yes" : "no"}>
                  <option value="yes">Active</option>
                  <option value="no">Inactive</option>
                </select>
              </Field>
            )}
            <Field
              label={edit ? "Reset Password (optional)" : "Password"}
              hint="At least 12 characters. Share passwords through a secure channel."
            >
              <input
                name="password"
                type="password"
                required={!edit}
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </Field>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setAdd(false);
                  setEdit(null);
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                <Check size={16} />
                Save Access
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function BrandSettings({
  brand,
  onChange,
  notify,
}: {
  brand: Brand;
  onChange: (b: Brand) => void;
  notify: (m: string, e?: boolean) => void;
}) {
  const [accent, setAccent] = useState(brand.accent),
    [busy, setBusy] = useState(false);
  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const b = await api<Brand>("/brand/logo", "POST", form);
      onChange({
        ...b,
        logoUrl:
          b.logoUrl + (b.logoUrl?.includes("?") ? "&v=" : "?v=") + Date.now(),
      });
      notify("Official logo saved.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="heading-row">
        <div>
          <div className="eyebrow">
            <span className="tiny-line" />
            MAESTRO IDENTITY
          </div>
          <h1>Brand Settings</h1>
          <p>
            Apply verified MAESTRO assets to your shared workspace and reports.
          </p>
        </div>
      </div>
      <div className="info-note">
        <Palette size={20} />
        <span>
          The supplied MAESTRO logo, slide artwork and Poppins typography are
          applied throughout your workspace. Saved brand preferences also apply
          to your exports.
        </span>
      </div>
      <section className="brand-settings table-section">
        <div className="section-title">
          <h3>Official MAESTRO Logo</h3>
          <p>
            The original wordmark from the supplied presentation is included.
            PNG or JPEG replacements are supported in both Excel and PDF
            exports.
          </p>
        </div>
        <div
          className={
            "brand-preview " +
            (brand.logoIsDefault === false ? "custom-logo" : "")
          }
        >
          {brand.logoUrl ? (
            <img src={brand.logoUrl} alt="Official MAESTRO logo" />
          ) : (
            <img src={originalIdentity.logoUrl} alt="Official MAESTRO logo" />
          )}
        </div>
        <div className="contact-actions">
          <label
            className={"secondary upload-label " + (busy ? "disabled" : "")}
          >
            <Upload size={16} />
            {brand.logoUrl ? "Replace Official Logo" : "Upload Official Logo"}
            <input
              className="file-input"
              type="file"
              aria-label="Upload official MAESTRO logo"
              disabled={busy}
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          {brand.logoUrl && brand.logoIsDefault === false && (
            <button
              className="secondary"
              disabled={busy}
              onClick={async () => {
                if (
                  !window.confirm(
                    "Restore the original MAESTRO logo from the supplied presentation?",
                  )
                )
                  return;
                try {
                  onChange(await api<Brand>("/brand/logo", "DELETE"));
                  notify("Original MAESTRO logo restored.");
                } catch (e) {
                  notify((e as Error).message, true);
                }
              }}
            >
              <Trash2 size={16} />
              Restore Original Logo
            </button>
          )}
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              onChange(
                await api<Brand>("/brand", "PUT", {
                  organization: "MAESTRO",
                  accent,
                }),
              );
              notify("Brand settings saved.");
            } catch (e) {
              notify((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="section-title separated">
            <h3>Official Accent Color</h3>
            <p>Enter the verified hexadecimal value from the brand guide.</p>
          </div>
          <div className="color-field">
            <input
              aria-label="Choose accent color"
              type="color"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
            />
            <Field label="Accent Color (HEX)">
              <input
                required
                value={accent}
                pattern="#[0-9a-fA-F]{6}"
                onChange={(e) => setAccent(e.target.value)}
                placeholder="#000000"
              />
            </Field>
          </div>
          <button className="primary" disabled={busy}>
            <Check size={16} />
            Save Brand Settings
          </button>
        </form>
        <div className="info-note">
          <FileText size={18} />
          <span>
            Reports use the MAESTRO wordmark and Poppins font. Colors and
            PNG/JPEG replacement logos also appear in English Excel and PDF
            reports. WebP replacements are displayed in the website only.
          </span>
        </div>
      </section>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
