/** Inline 16px stroke icons — no icon dependency, no external requests. */
const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const ShieldIcon = () => (
  <svg {...base}>
    <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
    <path d="M9.5 12.2l1.8 1.8 3.4-3.6" />
  </svg>
);

export const SearchIcon = () => (
  <svg {...base}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4 4" />
  </svg>
);

export const PlusIcon = () => (
  <svg {...base}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const CopyIcon = () => (
  <svg {...base}>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M15 6.5V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7a2 2 0 002 2h.5" />
  </svg>
);

export const PencilIcon = () => (
  <svg {...base}>
    <path d="M4 20h4l10.5-10.5a2.83 2.83 0 10-4-4L4 16v4z" />
    <path d="M13.5 6.5l4 4" />
  </svg>
);

export const EyeIcon = () => (
  <svg {...base}>
    <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

export const EyeOffIcon = () => (
  <svg {...base}>
    <path d="M4 4l16 16" />
    <path d="M9.6 6.5A9.6 9.6 0 0112 6c6 0 9.5 6 9.5 6a17 17 0 01-2.6 3.3" />
    <path d="M6.4 8.3A16.7 16.7 0 002.5 12S6 18 12 18a9.7 9.7 0 003.2-.5" />
    <path d="M10.2 10.3a2.6 2.6 0 003.6 3.6" />
  </svg>
);

export const RefreshIcon = () => (
  <svg {...base}>
    <path d="M20 12a8 8 0 10-2.9 6.2" />
    <path d="M20 6v5h-5" />
  </svg>
);

export const ShareIcon = () => (
  <svg {...base}>
    <circle cx="17.5" cy="6" r="2.7" />
    <circle cx="6.5" cy="12" r="2.7" />
    <circle cx="17.5" cy="18" r="2.7" />
    <path d="M9 10.7l6-3.4M9 13.3l6 3.4" />
  </svg>
);

export const TrashIcon = () => (
  <svg {...base}>
    <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" />
    <path d="M6 7l1 12a1 1 0 001 1h8a1 1 0 001-1l1-12" />
  </svg>
);

export const LockIcon = () => (
  <svg {...base}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
    <path d="M8.2 10.5V8a3.8 3.8 0 017.6 0v2.5" />
  </svg>
);

export const ExternalIcon = () => (
  <svg {...base}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-8.5 8.5" />
    <path d="M18 14.5V18a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h3.5" />
  </svg>
);

export const CheckIcon = () => (
  <svg {...base}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
