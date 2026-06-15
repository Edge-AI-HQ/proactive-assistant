import { Globe2, Loader2, Trash2 } from "lucide-react";
import { useBrowserLogins } from "@pin-ai/state";

import { Text } from "../primitives/Text";

/**
 * "Website logins" —— sites the user has logged into through the agent's
 * browser, listed + deletable.
 *
 * The login state (cookies) lives in the user's persistent Browserbase
 * Context; this only lists which sites have login state. Entries are keyed by
 * the login cookie's registrable domain (e.g. google.com), so one account
 * that spans subdomains shows as a single row. Deleting clears that site's
 * cookies from the Context (the agent will need to log in again next time).
 * Renders nothing when there are no logins. Data: /api/browser/logins.
 */
export function BrowserLoginsSection() {
  const { logins, isLoading, deleteLogin, deletingDomain } = useBrowserLogins();

  if (!isLoading && logins.length === 0) return null;

  return (
    <div className="glass-card-strong mt-3 overflow-hidden">
      <div className="p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06]">
            <Globe2 size={16} strokeWidth={1.5} className="text-foreground/60" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">Website logins</h3>
            <Text variant="caption" className="mt-0.5 block text-foreground/45">
              The assistant stays signed in to these sites for you — remove any anytime
            </Text>
          </div>
        </div>

        <div className="mt-3 space-y-1">
          {isLoading && logins.length === 0 ? (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-foreground/45">
              <Loader2 size={13} className="animate-spin" /> Loading
            </div>
          ) : (
            logins.map((login) => {
              const isDeleting = deletingDomain === login.siteDomain;
              const label = login.loginLabel || login.displayName;
              return (
                <div
                  key={login.siteDomain}
                  className="group flex items-center gap-2.5 rounded-xl bg-foreground/[0.02] px-3 py-2"
                >
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <Globe2 size={14} strokeWidth={1.5} className="text-foreground/35" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium text-foreground/80">
                        {login.siteDomain}
                      </span>
                      {login.status === "expired" && (
                        <Text variant="micro" weight="medium" className="text-amber-600">
                          Needs re-login
                        </Text>
                      )}
                    </div>
                    {label && (
                      <Text variant="micro" className="block truncate text-foreground/35">
                        {label}
                      </Text>
                    )}
                  </div>
                  <button
                    onClick={() => void deleteLogin(login.siteDomain)}
                    disabled={isDeleting}
                    aria-label={`Remove ${login.siteDomain} login`}
                    className="rounded-lg p-1 text-foreground/35 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                  >
                    {isDeleting ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
