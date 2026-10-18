/** A step as an agent would send it. `file` names a scratch file the bench creates (resolved to its path). */
export interface BenchStep {
  action: "click" | "fill" | "select" | "upload"
  target: string
  role?: string
  value?: string
  file?: string
}

export interface Task {
  name: string
  /** Path on the torture server. */
  path: string
  /** What `kite memory save` is told. */
  intent: string
  /** One array per page, the way an agent would batch them. */
  pages: BenchStep[][]
  /** True when the page is where the task is meant to end. */
  done: (page: { url: string; result: string }) => boolean
}

const SUMMARY = "Drive your real Chrome from any agent: batch actions, guarded."

export const TASKS: Task[] = [
  {
    // Ends one click short of the risky "Place order"; the agent finishes that itself.
    name: "multi-page-checkout",
    path: "/multi-page-checkout",
    intent: "check out the cart up to the review page",
    pages: [
      [{ action: "click", target: "Proceed to shipping" }],
      [
        { action: "fill", target: "Full name", value: "Ada Lovelace" },
        { action: "fill", target: "Address", value: "12 Analytical St" },
        { action: "fill", target: "City", value: "London" },
        { action: "select", target: "Country", value: "India" },
        { action: "click", target: "Continue to payment" },
      ],
    ],
    done: (p) => p.url.endsWith("/multi-page-checkout-review"),
  },
  {
    name: "store-listing",
    path: "/store-listing",
    intent: "fill the store listing and save the draft",
    pages: [
      [
        { action: "fill", target: "Title", value: "Kitestring" },
        { action: "fill", target: "Summary", value: SUMMARY },
        { action: "fill", target: "Description", value: "Lets agents operate your own browser safely." },
        { action: "select", target: "Category", value: "Developer Tools" },
        { action: "select", target: "Language", value: "English" },
        { action: "click", target: "Privacy", role: "tab" },
        { action: "fill", target: "Single purpose", value: "Browser automation for agents" },
        { action: "fill", target: "debugger justification", value: "Input events and snapshots" },
        { action: "fill", target: "nativeMessaging justification", value: "Talks to the local host" },
        { action: "fill", target: "tabs justification", value: "Tab groups per session" },
        { action: "fill", target: "host permissions justification", value: "Acts on any page the user opens" },
        { action: "click", target: "Does not collect user data" },
        { action: "click", target: "Package", role: "tab" },
        { action: "upload", target: "Extension zip", file: "kite.zip" },
        { action: "upload", target: "Screenshots", file: "s1.png" },
        { action: "click", target: "Save draft" },
      ],
    ],
    done: (p) => p.result.startsWith("saved:"),
  },
  {
    name: "cookie-wall",
    path: "/cookie-wall",
    intent: "set the newsletter email",
    pages: [
      [
        { action: "fill", target: "Email", value: "a@b.co" },
        { action: "click", target: "Continue" },
      ],
    ],
    done: (p) => p.result.startsWith("continued:"),
  },
  {
    name: "file-upload",
    path: "/file-upload",
    intent: "upload the extension files",
    pages: [
      [
        { action: "upload", target: "Extension zip", file: "kite.zip" },
        { action: "upload", target: "Choose screenshots", file: "s1.png" },
        { action: "upload", target: "Drop icon here", file: "icon.png" },
      ],
    ],
    done: (p) => {
      try {
        const r = JSON.parse(p.result) as { a: string[]; b: string[]; c: string[] }
        return r.a.length > 0 && r.b.length > 0 && r.c.length > 0
      } catch {
        return false
      }
    },
  },
]
