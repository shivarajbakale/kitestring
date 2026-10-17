/** Authored icons: 16 px grid, 1.6 px stroke, currentColor. */
type P = { size?: number }

const svg = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
})

export const PauseIcon = ({ size = 16 }: P) => (
  <svg {...svg(size)}>
    <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth={2.2} />
  </svg>
)

export const PlayIcon = ({ size = 16 }: P) => (
  <svg {...svg(size)}>
    <path d="M5 3.2v9.6L12.6 8z" fill="currentColor" />
  </svg>
)

export const CheckIcon = ({ size = 12 }: P) => (
  <svg {...svg(size)}>
    <path d="M3.5 8.5l3 3 6-7" strokeWidth={2} />
  </svg>
)

export const CrossIcon = ({ size = 12 }: P) => (
  <svg {...svg(size)}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" strokeWidth={2} />
  </svg>
)

export const PanelIcon = ({ size = 16 }: P) => (
  <svg {...svg(size)}>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M10 3v10" />
  </svg>
)

export const ChevronIcon = ({ size = 14 }: P) => (
  <svg {...svg(size)}>
    <path d="M6 4l4 4-4 4" />
  </svg>
)
